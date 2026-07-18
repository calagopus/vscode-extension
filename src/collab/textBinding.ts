import * as vscode from 'vscode';
import type * as Y from 'yjs';
import { log } from '../log.ts';

const REMOTE_ORIGIN = 'remote';

export class TextBinding {
  private readonly ytext: Y.Text;
  private readonly localOrigin = Symbol('calagopus-local');
  private readonly disposables: vscode.Disposable[] = [];

  private applyingRemote = false;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly doc: Y.Doc,
    private readonly document: vscode.TextDocument,
    private readonly onLocalUpdate: (update: Uint8Array) => void,
  ) {
    this.ytext = doc.getText('content');

    this.ytext.observe(this.onYTextChange);
    this.doc.on('update', this.onDocUpdate);
    void this.reconcileInitial().then(() => {
      if (this.disposed) {
        return;
      }
      this.disposables.push(vscode.workspace.onDidChangeTextDocument(this.onDocumentChange));
    });
  }

  dispose(): void {
    this.disposed = true;
    this.ytext.unobserve(this.onYTextChange);
    this.doc.off('update', this.onDocUpdate);
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }

  private async reconcileInitial(): Promise<void> {
    if (this.ytext.toString() === this.document.getText()) {
      return;
    }
    await this.forceReconcile();
  }

  private async forceReconcile(): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      new vscode.Position(0, 0),
      this.document.positionAt(this.document.getText().length),
    );
    edit.replace(this.document.uri, fullRange, this.ytext.toString());
    if (!(await this.applyGuarded(edit))) {
      log.error(`collab: could not reconcile ${this.document.uri.toString()} with the shared document`);
    }
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === REMOTE_ORIGIN) {
      return;
    }
    this.onLocalUpdate(update);
  };

  private onYTextChange = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
    if (transaction.origin !== REMOTE_ORIGIN) {
      return;
    }
    const delta = event.delta;
    this.queue = this.queue
      .then(() => this.applyDelta(delta))
      .catch((err) => {
        log.error(`collab: failed to apply remote edit to ${this.document.uri.toString()}: ${err}`);
      });
  };

  private async applyDelta(delta: Y.YTextEvent['delta']): Promise<void> {
    if (this.disposed) {
      return;
    }
    const edit = new vscode.WorkspaceEdit();

    let index = 0;
    for (const op of delta) {
      if (op.retain != null) {
        index += op.retain;
      } else if (op.insert != null) {
        const text = typeof op.insert === 'string' ? op.insert : '';
        edit.insert(this.document.uri, this.document.positionAt(index), text);
      } else if (op.delete != null) {
        const start = this.document.positionAt(index);
        const end = this.document.positionAt(index + op.delete);
        edit.delete(this.document.uri, new vscode.Range(start, end));
        index += op.delete;
      }
    }
    const applied = await this.applyGuarded(edit);
    if (this.disposed) {
      return;
    }

    if (!applied || this.document.getText() !== this.ytext.toString()) {
      await this.forceReconcile();
    }
  }

  private async applyGuarded(edit: vscode.WorkspaceEdit): Promise<boolean> {
    this.applyingRemote = true;
    try {
      return await vscode.workspace.applyEdit(edit);
    } finally {
      this.applyingRemote = false;
    }
  }

  private onDocumentChange = (e: vscode.TextDocumentChangeEvent): void => {
    if (this.disposed || this.applyingRemote) {
      return;
    }
    if (e.document.uri.toString() !== this.document.uri.toString() || e.contentChanges.length === 0) {
      return;
    }

    this.doc.transact(() => {
      for (const change of e.contentChanges) {
        if (change.rangeLength > 0) {
          this.ytext.delete(change.rangeOffset, change.rangeLength);
        }
        if (change.text.length > 0) {
          this.ytext.insert(change.rangeOffset, change.text);
        }
      }
    }, this.localOrigin);
  };
}
