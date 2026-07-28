import type * as vscode from 'vscode';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { log } from '../log.ts';
import type { WingsSocketLease } from '../wings/socketHub.ts';
import { fromBase64, toBase64 } from './base64.ts';
import { CursorDecorations, cursorColor } from './cursors.ts';
import { TextBinding } from './textBinding.ts';

const UPDATE_CHUNK_SIZE = 16 * 1024;
const SAVE_TIMEOUT_MS = 15_000;

let nextEditorId = 0;

function normalizePath(path: string): string {
  return path.replace(/^\/+/, '');
}

export interface CollabParticipant {
  user: string;
  name: string;
  avatar: string | null;
}

export interface CollabConflict {
  hash: string | null;
  deleted: boolean;
}

export class CollabConflictError extends Error {
  constructor(readonly conflict: CollabConflict) {
    super(
      conflict.deleted
        ? 'The file was deleted on disk outside of this session. Resolve the conflict from the Calagopus notification.'
        : 'The file was changed on disk outside of this session. Resolve the conflict from the Calagopus notification.',
    );
    this.name = 'CollabConflictError';
  }
}

export interface SessionCallbacks {
  onActiveChange: () => void;
  onParticipants: (participants: CollabParticipant[]) => void;
  onDirtyChange: () => void;
  onConflict: (conflict: CollabConflict | null) => void;
  onSaved: (revisionId: number | null) => void;
  onError: (message: string) => void;
}

export class CollabSession {
  private doc: Y.Doc | null = null;
  private awareness: Awareness | null = null;
  private binding: TextBinding | null = null;
  private cursors: CursorDecorations | null = null;

  private subscribed = false;
  private subscribedThisConnection = false;
  private disposed = false;
  private dirty = false;
  private localEdits = false;
  private conflictState: CollabConflict | null = null;
  private readonly pendingSaves = new Set<{
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private readonly path: string;
  private readonly editorId = String(++nextEditorId);

  constructor(
    private readonly lease: WingsSocketLease,
    private readonly document: vscode.TextDocument,
    private readonly username: string,
    private readonly callbacks: SessionCallbacks,
  ) {
    this.path = document.uri.path;

    this.lease.on('file collab sync', this.onSync);
    this.lease.on('file collab update', this.onUpdate);
    this.lease.on('file collab awareness', this.onAwareness);
    this.lease.on('file collab participants', this.onParticipants);
    this.lease.on('file collab saved', this.onSaved);
    this.lease.on('file collab conflict', this.onConflictEvent);
    this.lease.on('file collab error', this.onErrorEvent);

    this.lease.on('CONNECTION_STATE', (state: string) => {
      if (state !== 'connected') {
        this.subscribedThisConnection = false;
      }
    });
    this.lease.whenAuthenticated(() => {
      if (this.subscribedThisConnection) {
        return;
      }
      this.subscribedThisConnection = true;
      this.subscribed = true;
      this.lease.send('file collab subscribe', [this.path, this.editorId]);
    });
  }

  get active(): boolean {
    return this.doc !== null;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  get hasLocalEdits(): boolean {
    return this.localEdits;
  }

  get conflict(): CollabConflict | null {
    return this.conflictState;
  }

  private setDirty(value: boolean): void {
    if (this.dirty === value) {
      return;
    }
    this.dirty = value;
    this.callbacks.onDirtyChange();
  }

  private setConflict(value: CollabConflict | null): void {
    const current = this.conflictState;
    const unchanged =
      current === value || (!!current && !!value && current.hash === value.hash && current.deleted === value.deleted);
    if (unchanged) {
      return;
    }
    this.conflictState = value;
    this.callbacks.onConflict(value);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const pending of this.pendingSaves) {
      clearTimeout(pending.timer);
      pending.reject(new Error('collaboration session closed'));
    }
    this.pendingSaves.clear();
    this.destroyDoc();
    if (this.subscribed) {
      this.lease.send('file collab unsubscribe', [this.path, this.editorId]);
    }
    this.lease.release();
  }

  save(options?: { force?: boolean; expectedHash?: string | null }): Promise<void> {
    if (!this.active) {
      return Promise.reject(new Error('collaboration is not active for this file'));
    }
    return new Promise((resolve, reject) => {
      const pending = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pendingSaves.delete(pending);
          reject(new Error('timed out waiting for the panel to save the file'));
        }, SAVE_TIMEOUT_MS),
      };
      this.pendingSaves.add(pending);

      const args = [this.path];
      if (options?.force) {
        args.push('1');
        if (options.expectedHash) {
          args.push(options.expectedHash);
        }
      }
      this.lease.send('file collab save', args);
    });
  }

  reload(): void {
    if (!this.subscribed) {
      return;
    }
    this.lease.send('file collab reload', [this.path]);
  }

  private matches(path: string): boolean {
    return normalizePath(path) === normalizePath(this.path);
  }

  private onSync = (syncPath: string, state: string, meta?: string): void => {
    if (this.disposed || !this.matches(syncPath)) {
      return;
    }

    let dirty = false;
    let conflict: CollabConflict | null = null;
    try {
      const parsed = JSON.parse(meta ?? '{}');
      dirty = Boolean(parsed.dirty);
      conflict = parsed.conflict ?? null;
    } catch {
      // ignore
    }
    this.setDirty(dirty);
    this.setConflict(conflict);
    this.localEdits = false;

    for (const pending of this.pendingSaves) {
      clearTimeout(pending.timer);
      pending.reject(new Error('the collaboration session resynced before the save completed'));
    }
    this.pendingSaves.clear();

    this.destroyDoc();

    const doc = new Y.Doc();
    Y.applyUpdate(doc, fromBase64(state), 'remote');

    const awareness = new Awareness(doc);
    awareness.setLocalStateField('user', {
      name: this.username,
      color: cursorColor(doc.clientID),
    });

    const binding = new TextBinding(doc, this.document, (update) => this.sendUpdate(update));

    awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin === 'remote') {
          return;
        }
        const changed = added.concat(updated, removed);
        this.lease.send('file collab awareness', [this.path, toBase64(encodeAwarenessUpdate(awareness, changed))]);
      },
    );

    this.doc = doc;
    this.awareness = awareness;
    this.binding = binding;
    this.cursors = new CursorDecorations(doc, awareness, this.document);

    this.lease.send('file collab awareness', [this.path, toBase64(encodeAwarenessUpdate(awareness, [doc.clientID]))]);

    this.callbacks.onActiveChange();
    log.info(`collab: session active for ${this.path}`);
  };

  private onUpdate = (updatePath: string, update: string): void => {
    if (this.disposed || !this.matches(updatePath) || !this.doc) {
      return;
    }
    Y.applyUpdate(this.doc, fromBase64(update), 'remote');
    this.setDirty(true);
  };

  private onAwareness = (awarenessPath: string, update: string): void => {
    if (this.disposed || !this.matches(awarenessPath) || !this.awareness) {
      return;
    }
    applyAwarenessUpdate(this.awareness, fromBase64(update), 'remote');
  };

  private onParticipants = (participantsPath: string, data: string): void => {
    if (this.disposed || !this.matches(participantsPath)) {
      return;
    }
    try {
      this.callbacks.onParticipants(JSON.parse(data) as CollabParticipant[]);
    } catch {
      // ignore
    }
  };

  private onSaved = (savedPath: string, data: string): void => {
    if (!this.matches(savedPath)) {
      return;
    }
    this.setDirty(false);
    this.setConflict(null);
    this.localEdits = false;
    for (const pending of this.pendingSaves) {
      clearTimeout(pending.timer);
      pending.resolve();
    }
    this.pendingSaves.clear();

    let revisionId: number | null = null;
    try {
      revisionId = (JSON.parse(data) as { revision_id?: number | null }).revision_id ?? null;
    } catch {
      // ignore
    }
    this.callbacks.onSaved(revisionId);
  };

  private onConflictEvent = (conflictPath: string, data?: string): void => {
    if (this.disposed || !this.matches(conflictPath)) {
      return;
    }

    let conflict: CollabConflict | null = null;
    try {
      conflict = (JSON.parse(data ?? 'null') as CollabConflict | null) ?? null;
    } catch {
      // ignore
    }

    if (conflict) {
      const error = new CollabConflictError(conflict);
      for (const pending of this.pendingSaves) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pendingSaves.clear();
    }
    this.setConflict(conflict);
  };

  private onErrorEvent = (errorPath: string, message: string): void => {
    if (this.disposed || !this.matches(errorPath)) {
      return;
    }

    const wasActive = this.doc !== null;
    this.destroyDoc();
    this.setDirty(false);
    this.setConflict(null);

    for (const pending of this.pendingSaves) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pendingSaves.clear();

    if (message === 'resync' || wasActive) {
      this.lease.send('file collab subscribe', [this.path, this.editorId]);
      if (message !== 'resync') {
        this.callbacks.onError(message);
      }
    } else {
      this.subscribed = false;
      this.callbacks.onError(message);
    }
    this.callbacks.onActiveChange();
  };

  private sendUpdate(update: Uint8Array): void {
    this.setDirty(true);
    this.localEdits = true;
    const encoded = toBase64(update);
    for (let i = 0; i < encoded.length; i += UPDATE_CHUNK_SIZE) {
      const finished = i + UPDATE_CHUNK_SIZE >= encoded.length;
      this.lease.send('file collab update', [
        this.path,
        finished ? '1' : '0',
        encoded.slice(i, i + UPDATE_CHUNK_SIZE),
        this.editorId,
      ]);
    }
  }

  private destroyDoc(): void {
    this.cursors?.dispose();
    this.cursors = null;
    this.binding?.dispose();
    this.binding = null;
    this.awareness?.destroy();
    this.awareness = null;
    this.doc?.destroy();
    this.doc = null;
  }
}
