import * as vscode from 'vscode';
import type { FileRevision } from '../api/types.ts';
import { decodeAuthority, refOf } from '../fs/fileSystemProvider.ts';
import { log } from '../log.ts';
import type { Session } from '../session.ts';

export const REVISION_SCHEME = 'calagopus-revision';

function revisionUri(fileUri: vscode.Uri, revisionId: number): vscode.Uri {
  return fileUri.with({
    scheme: REVISION_SCHEME,
    query: `revision=${revisionId}`,
  });
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = units[0];
  for (const next of units.slice(1)) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return unit === 'B' ? `${value} B` : `${value.toFixed(1)} ${unit}`;
}

function formatWhen(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly session: Session) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { origin, server } = decodeAuthority(uri.authority);
    const revision = Number(new URLSearchParams(uri.query).get('revision'));
    const client = await this.session.client(origin);
    return new TextDecoder().decode(await client.getFileRevisionContent(server, revision));
  }
}

class RevisionItem extends vscode.TreeItem {
  constructor(
    readonly fileUri: vscode.Uri,
    readonly revision: FileRevision,
    readonly previousId: number | null,
  ) {
    super(`#${revision.id}`, vscode.TreeItemCollapsibleState.None);

    const who = revision.user?.username ?? 'System';
    const parts = [who, formatWhen(revision.created), formatBytes(revision.size)];
    if (revision.is_snapshot) {
      parts.push('Full Snapshot');
    }
    this.description = parts.join(' • ');
    this.iconPath = new vscode.ThemeIcon(revision.is_snapshot ? 'history' : 'git-commit');
    this.tooltip = new vscode.MarkdownString(
      `**Revision #${revision.id}**${revision.is_snapshot ? ' - Full Snapshot' : ''}\n\n` +
        `${who} • ${new Date(revision.created).toLocaleString()} • ${formatBytes(revision.size)}`,
    );
    this.contextValue = previousId !== null ? 'calagopusRevisionWithPrevious' : 'calagopusRevision';
    this.command = {
      command: 'calagopus.revisions.viewDiff',
      title: 'View Diff Against Current File',
      arguments: [this],
    };
  }
}

class FileRevisionsProvider implements vscode.TreeDataProvider<RevisionItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  fileUri: vscode.Uri | null = null;

  constructor(private readonly session: Session) {}

  dispose(): void {
    this.changeEmitter.dispose();
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  trackEditor(editor: vscode.TextEditor | undefined): boolean {
    const uri = editor?.document.uri;
    if (uri?.scheme !== 'calagopus' || uri.toString() === this.fileUri?.toString()) {
      return false;
    }

    this.fileUri = uri;
    this.refresh();
    return true;
  }

  getTreeItem(item: RevisionItem): vscode.TreeItem {
    return item;
  }

  async getChildren(item?: RevisionItem): Promise<RevisionItem[]> {
    if (item || !this.fileUri) {
      return [];
    }
    const fileUri = this.fileUri;
    const { origin, server } = refOf(fileUri);
    try {
      const client = await this.session.clientIfSignedIn(origin);
      if (!client) {
        return [];
      }
      const revisions = await client.getFileRevisions(server, fileUri.path);
      return revisions.map((revision, i) => new RevisionItem(fileUri, revision, revisions[i + 1]?.id ?? null));
    } catch (err) {
      log.warn(`revisions: failed to list for ${fileUri.toString()}: ${err}`);
      return [];
    }
  }
}

export function registerRevisionsView(session: Session): vscode.Disposable[] {
  const provider = new FileRevisionsProvider(session);
  const view = vscode.window.createTreeView('calagopusRevisions', {
    treeDataProvider: provider,
  });

  const syncTitle = () => {
    view.description = provider.fileUri ? basename(provider.fileUri.path) : undefined;
  };
  if (provider.trackEditor(vscode.window.activeTextEditor)) {
    syncTitle();
  }

  const restore = async (item: RevisionItem) => {
    const { origin, server } = refOf(item.fileUri);
    try {
      const client = await session.client(origin);
      const content = new TextDecoder().decode(await client.getFileRevisionContent(server, item.revision.id));
      const document = await vscode.workspace.openTextDocument(item.fileUri);
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length));
      edit.replace(document.uri, fullRange, content);
      await vscode.workspace.applyEdit(edit);
      await vscode.window.showTextDocument(document, { preview: false });
      vscode.window.setStatusBarMessage(`Revision #${item.revision.id} restored into editor`, 5000);
    } catch (err) {
      vscode.window.showErrorMessage(`Calagopus: could not restore revision #${item.revision.id}: ${err}`);
    }
  };

  return [
    provider,
    view,
    vscode.workspace.registerTextDocumentContentProvider(REVISION_SCHEME, new RevisionContentProvider(session)),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (provider.trackEditor(editor)) {
        syncTitle();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.toString() === provider.fileUri?.toString()) {
        provider.refresh();
      }
    }),

    vscode.commands.registerCommand('calagopus.revisions.refresh', () => provider.refresh()),

    vscode.commands.registerCommand('calagopus.revisions.viewDiff', (item?: RevisionItem) => {
      if (!item) {
        return;
      }
      const name = basename(item.fileUri.path);
      return vscode.commands.executeCommand(
        'vscode.diff',
        revisionUri(item.fileUri, item.revision.id),
        item.fileUri,
        `${name} (#${item.revision.id} ↔ current)`,
      );
    }),

    vscode.commands.registerCommand('calagopus.revisions.compareToPrevious', (item?: RevisionItem) => {
      if (!item || item.previousId === null) {
        return;
      }
      const name = basename(item.fileUri.path);
      return vscode.commands.executeCommand(
        'vscode.diff',
        revisionUri(item.fileUri, item.previousId),
        revisionUri(item.fileUri, item.revision.id),
        `${name} (#${item.previousId} ↔ #${item.revision.id})`,
      );
    }),

    vscode.commands.registerCommand('calagopus.revisions.restore', (item?: RevisionItem) => {
      if (item) {
        return restore(item);
      }
    }),
  ];
}
