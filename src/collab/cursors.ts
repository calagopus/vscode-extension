import * as vscode from 'vscode';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

const CURSOR_COLORS = ['#e03131', '#c2255c', '#9c36b5', '#3b5bdb', '#1971c2', '#099268', '#e8590c', '#f08c00'];

export function cursorColor(seed: number): string {
  return CURSOR_COLORS[Math.abs(seed) % CURSOR_COLORS.length];
}

interface RemoteSelection {
  anchor: Y.RelativePosition;
  head: Y.RelativePosition;
}

interface ClientDecorations {
  caret: vscode.TextEditorDecorationType;
  selection: vscode.TextEditorDecorationType;
  flag: vscode.TextEditorDecorationType;
}

export class CursorDecorations {
  private readonly decorations = new Map<number, ClientDecorations>();
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  constructor(
    private readonly doc: Y.Doc,
    private readonly awareness: Awareness,
    private readonly document: vscode.TextDocument,
  ) {
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor.document.uri.toString() === this.document.uri.toString()) {
          this.publishSelection(e.textEditor);
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.render()),
    );

    this.awareness.on('change', this.render);

    const editor = vscode.window.visibleTextEditors.find(
      (ed) => ed.document.uri.toString() === this.document.uri.toString(),
    );
    if (editor) {
      this.publishSelection(editor);
    }

    this.render();
  }

  dispose(): void {
    this.disposed = true;
    this.awareness.off('change', this.render);
    for (const d of this.disposables) {
      d.dispose();
    }
    for (const types of this.decorations.values()) {
      types.caret.dispose();
      types.selection.dispose();
      types.flag.dispose();
    }
    this.decorations.clear();
  }

  private publishSelection(editor: vscode.TextEditor): void {
    const ytext = this.doc.getText('content');
    const selection = editor.selection;
    let anchor = this.document.offsetAt(selection.start);
    let head = this.document.offsetAt(selection.end);
    if (selection.isReversed) {
      [anchor, head] = [head, anchor];
    }

    this.awareness.setLocalStateField('selection', {
      anchor: Y.createRelativePositionFromTypeIndex(ytext, anchor),
      head: Y.createRelativePositionFromTypeIndex(ytext, head),
    });
  }

  private render = (): void => {
    if (this.disposed) {
      return;
    }

    const editors = vscode.window.visibleTextEditors.filter(
      (ed) => ed.document.uri.toString() === this.document.uri.toString(),
    );
    if (editors.length === 0) {
      return;
    }

    const ytext = this.doc.getText('content');
    const live = new Set<number>();
    const rendered = new Map<number, { selection: vscode.Range; caret: vscode.Range; name: string }>();

    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.awareness.clientID) {
        return;
      }

      const selection = state.selection as RemoteSelection | undefined;
      const user = state.user as { name?: string; color?: string } | undefined;
      if (!selection?.anchor || !selection?.head) {
        return;
      }

      const anchorAbs = Y.createAbsolutePositionFromRelativePosition(selection.anchor, this.doc);
      const headAbs = Y.createAbsolutePositionFromRelativePosition(selection.head, this.doc);
      if (!anchorAbs || !headAbs || anchorAbs.type !== ytext || headAbs.type !== ytext) {
        return;
      }

      const [from, to] =
        anchorAbs.index <= headAbs.index ? [anchorAbs.index, headAbs.index] : [headAbs.index, anchorAbs.index];
      const head = this.document.positionAt(headAbs.index);
      const color = user?.color ?? cursorColor(clientId);
      const name = user?.name ?? 'anonymous';

      live.add(clientId);
      rendered.set(clientId, {
        selection: new vscode.Range(this.document.positionAt(from), this.document.positionAt(to)),
        caret: new vscode.Range(head, head),
        name,
      });
      this.decorationTypes(clientId, color, name);
    });

    for (const [clientId, types] of this.decorations) {
      const entry = rendered.get(clientId);
      for (const editor of editors) {
        editor.setDecorations(
          types.selection,
          entry && !entry.selection.isEmpty ? [{ range: entry.selection, hoverMessage: entry.name }] : [],
        );
        editor.setDecorations(types.caret, entry ? [{ range: entry.caret, hoverMessage: entry.name }] : []);
        editor.setDecorations(types.flag, entry ? [{ range: entry.caret }] : []);
      }
      if (!live.has(clientId)) {
        types.caret.dispose();
        types.selection.dispose();
        types.flag.dispose();
        this.decorations.delete(clientId);
      }
    }
  };

  private decorationTypes(clientId: number, color: string, name: string): ClientDecorations {
    const existing = this.decorations.get(clientId);
    if (existing) {
      return existing;
    }

    const types: ClientDecorations = {
      selection: vscode.window.createTextEditorDecorationType({
        backgroundColor: `${color}44`,
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      }),
      caret: vscode.window.createTextEditorDecorationType({
        borderColor: color,
        borderStyle: 'solid',
        borderWidth: '0 0 0 2px',
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      }),
      flag: vscode.window.createTextEditorDecorationType({
        after: {
          contentText: name,
          backgroundColor: color,
          color: '#ffffff',
          fontStyle: 'normal',
          fontWeight: 'normal',
          textDecoration:
            'none; position: absolute; top: -1.2em; margin-left: -2px; font-size: 10px; line-height: 1.2;' +
            ' padding: 0 3px; border-radius: 2px; white-space: nowrap; pointer-events: none; z-index: 10',
        },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      }),
    };

    this.decorations.set(clientId, types);

    return types;
  }
}
