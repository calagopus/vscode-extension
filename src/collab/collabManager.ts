import * as vscode from 'vscode';
import { decodeAuthority, refOf } from '../fs/fileSystemProvider.ts';
import { log } from '../log.ts';
import type { Session } from '../session.ts';
import type { WingsSocketHub } from '../wings/socketHub.ts';
import { CollabConflictError, type CollabParticipant, CollabSession } from './session.ts';

const CONFIG_KEY = 'calagopus.collaboration.enabled';
const DISK_SCHEME = 'calagopus-collab-disk';

const VIEW_DIFF = 'View Diff';
const LOAD_DISK = 'Load Disk Version';
const KEEP_EDITOR = 'Keep Editor Version';

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export interface CollabRegistry {
  hasSession(uri: vscode.Uri): boolean;
  saveViaCollab(uri: vscode.Uri): Promise<void>;
  shouldSkipSave(uri: vscode.Uri): boolean;
}

export class CollabManager implements CollabRegistry, vscode.FileDecorationProvider {
  private readonly sessions = new Map<string, CollabSession>();
  private readonly participants = new Map<string, CollabParticipant[]>();
  private readonly usernames = new Map<string, string>();
  private readonly starting = new Set<string>();
  private readonly conflictPrompts = new Set<string>();
  private readonly saveReasons = new Map<string, vscode.TextDocumentSaveReason>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusItem: vscode.StatusBarItem;
  private readonly decorationsEmitter = new vscode.EventEmitter<vscode.Uri>();

  readonly onDidChangeFileDecorations = this.decorationsEmitter.event;

  private enabled: boolean;
  private disposed = false;

  constructor(
    private readonly hub: WingsSocketHub,
    private readonly session: Session,
  ) {
    this.enabled = this.readEnabled();
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    this.statusItem.tooltip = 'People currently editing this file with you';

    this.disposables.push(
      this.statusItem,
      this.decorationsEmitter,
      vscode.window.registerFileDecorationProvider(this),
      vscode.workspace.registerTextDocumentContentProvider(DISK_SCHEME, {
        provideTextDocumentContent: async (uri) => {
          const { origin, server } = decodeAuthority(uri.authority);
          const client = await this.session.client(origin);
          return new TextDecoder().decode(await client.readFile(server, uri.path));
        },
      }),
      vscode.workspace.onDidOpenTextDocument((doc) => this.maybeStart(doc)),
      vscode.workspace.onWillSaveTextDocument((e) => {
        if (e.document.uri.scheme === 'calagopus') {
          this.saveReasons.set(e.document.uri.toString(), e.reason);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => this.stop(doc.uri)),
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshStatus()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(CONFIG_KEY)) {
          this.onConfigChange();
        }
      }),
    );

    for (const doc of vscode.workspace.textDocuments) {
      this.maybeStart(doc);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.participants.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  hasSession(uri: vscode.Uri): boolean {
    return this.sessions.has(uri.toString());
  }

  shouldSkipSave(uri: vscode.Uri): boolean {
    const key = uri.toString();
    const reason = this.saveReasons.get(key);
    this.saveReasons.delete(key);

    const session = this.sessions.get(key);
    if (!session?.active) {
      return false;
    }
    if (reason === undefined || reason === vscode.TextDocumentSaveReason.Manual) {
      return false;
    }

    return !session.hasLocalEdits;
  }

  async saveViaCollab(uri: vscode.Uri): Promise<void> {
    const session = this.sessions.get(uri.toString());
    if (!session) {
      throw new Error('no collaboration session for this file');
    }

    if (session.conflict) {
      void this.promptConflict(uri);
      throw new CollabConflictError(session.conflict);
    }

    try {
      await session.save();
    } catch (err) {
      if (err instanceof CollabConflictError) {
        void this.promptConflict(uri);
      }
      throw err;
    }
  }

  private readEnabled(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(CONFIG_KEY, true);
  }

  private onConfigChange(): void {
    const next = this.readEnabled();
    if (next === this.enabled) {
      return;
    }
    this.enabled = next;
    if (!next) {
      for (const [key, session] of this.sessions) {
        session.dispose();
        this.sessions.delete(key);
        this.participants.delete(key);
        this.decorationsEmitter.fire(vscode.Uri.parse(key));
      }
      this.refreshStatus();
    } else {
      for (const doc of vscode.workspace.textDocuments) {
        this.maybeStart(doc);
      }
    }
  }

  private maybeStart(document: vscode.TextDocument): void {
    if (!this.enabled || this.disposed) {
      return;
    }
    if (document.uri.scheme !== 'calagopus' || document.isUntitled) {
      return;
    }
    const key = document.uri.toString();
    if (this.sessions.has(key) || this.starting.has(key)) {
      return;
    }
    void this.start(document);
  }

  private async start(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    const { origin, server } = refOf(document.uri);
    if (!origin) {
      return;
    }

    this.starting.add(key);
    let username: string;
    try {
      username = await this.resolveUsername(origin);
    } finally {
      this.starting.delete(key);
    }

    if (this.disposed || !this.enabled || this.sessions.has(key)) {
      return;
    }
    if (!vscode.workspace.textDocuments.some((d) => d.uri.toString() === key)) {
      return;
    }

    const lease = this.hub.acquire(origin, server);
    const session = new CollabSession(lease, document, username, {
      onActiveChange: () => this.refreshStatus(),
      onParticipants: (participants) => {
        this.participants.set(key, participants);
        this.refreshStatus();
      },
      onDirtyChange: () => this.decorationsEmitter.fire(document.uri),
      onConflict: (conflict) => {
        this.decorationsEmitter.fire(document.uri);
        if (conflict) {
          void this.promptConflict(document.uri);
        }
      },
      onError: (message) => {
        log.warn(`collab [${key}]: ${message}`);
      },
    });
    this.sessions.set(key, session);
    log.info(`collab: watching ${key}`);
  }

  private stop(uri: vscode.Uri): void {
    const key = uri.toString();
    const session = this.sessions.get(key);
    if (session) {
      session.dispose();
      this.sessions.delete(key);
      this.decorationsEmitter.fire(uri);
    }
    this.participants.delete(key);
    this.refreshStatus();
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const session = this.sessions.get(uri.toString());
    if (session?.conflict) {
      return {
        badge: '!',
        tooltip: session.conflict.deleted
          ? 'File deleted on disk outside of the editor'
          : 'File changed on disk outside of the editor',
        color: new vscode.ThemeColor('list.warningForeground'),
      };
    }
    if (!session?.isDirty) {
      return undefined;
    }
    return {
      badge: '●',
      tooltip: 'Unsaved collaborative changes',
      color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
    };
  }

  private async promptConflict(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    if (this.conflictPrompts.has(key)) {
      return;
    }
    this.conflictPrompts.add(key);
    try {
      const name = basename(uri.path);

      for (;;) {
        const session = this.sessions.get(key);
        const conflict = session?.conflict;
        if (!session || !conflict) {
          return;
        }

        const message = conflict.deleted
          ? `Calagopus: "${name}" was deleted on disk outside of the editor.`
          : `Calagopus: "${name}" was changed on disk outside of the editor (e.g. via SFTP).`;
        const actions = conflict.deleted ? [KEEP_EDITOR] : [VIEW_DIFF, LOAD_DISK, KEEP_EDITOR];

        const picked = await vscode.window.showWarningMessage(message, ...actions);
        const current = this.sessions.get(key);
        if (!picked || !current?.conflict) {
          return;
        }

        switch (picked) {
          case VIEW_DIFF: {
            const diskUri = uri.with({
              scheme: DISK_SCHEME,
              query: `disk=${current.conflict.hash ?? Date.now()}`,
            });
            await vscode.commands.executeCommand('vscode.diff', diskUri, uri, `${name} (Disk ↔ Editor)`);
            continue;
          }
          case LOAD_DISK: {
            if (await this.confirmLoadDisk(key, name)) {
              current.reload();
              return;
            }
            continue;
          }
          case KEEP_EDITOR: {
            try {
              await current.save({ force: true, expectedHash: current.conflict.hash });
            } catch (err) {
              if (!(err instanceof CollabConflictError)) {
                vscode.window.showErrorMessage(`Calagopus: could not save "${name}": ${err}`);
              }
            }
            return;
          }
        }
      }
    } finally {
      this.conflictPrompts.delete(key);
    }
  }

  private async confirmLoadDisk(key: string, name: string): Promise<boolean> {
    const participants = this.participants.get(key)?.length ?? 0;
    const detail =
      participants > 1
        ? `This will replace the editor contents for all ${participants} people in this session with the file currently on disk. Unsaved changes will be lost.`
        : 'This will replace the editor contents with the file currently on disk. Unsaved changes will be lost.';

    const picked = await vscode.window.showWarningMessage(
      `Load the disk version of "${name}"?`,
      { modal: true, detail },
      LOAD_DISK,
    );
    return picked === LOAD_DISK;
  }

  private async resolveUsername(origin: string): Promise<string> {
    const cached = this.usernames.get(origin);
    if (cached) {
      return cached;
    }
    let name = 'VS Code';
    try {
      const client = await this.session.clientIfSignedIn(origin);
      if (client) {
        name = (await client.getAccount()).username || name;
      }
    } catch (err) {
      log.warn(`collab: could not resolve username for ${origin}: ${err}`);
    }
    this.usernames.set(origin, name);
    return name;
  }

  private refreshStatus(): void {
    const editor = vscode.window.activeTextEditor;
    const key = editor?.document.uri.toString();
    const participants = key ? this.participants.get(key) : undefined;

    if (!key || !editor || !this.sessions.has(key)) {
      this.statusItem.hide();
      return;
    }
    const count = Math.max(participants?.length ?? 0, 1);
    const self = this.usernames.get(refOf(editor.document.uri).origin ?? '');
    const others = (participants ?? []).filter((p) => p.name !== self).map((p) => p.name);
    this.statusItem.text = `$(live-share) ${count}`;
    this.statusItem.tooltip = others.length > 0 ? `Editing with: ${others.join(', ')}` : 'Collaboration session active';
    this.statusItem.show();
  }
}
