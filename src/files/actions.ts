import * as vscode from 'vscode';
import type { ChmodFile } from '../api/types.ts';
import { type CalagopusFileSystem, refOf } from '../fs/fileSystemProvider.ts';
import { log } from '../log.ts';
import { basename, dirname } from '../paths.ts';
import type { Session } from '../session.ts';
import { ARCHIVE_FORMATS, generateArchiveName } from './archive.ts';
import type { FileOperationTracker } from './operations.ts';

interface FormatPick extends vscode.QuickPickItem {
  index: number;
}

function selection(uri: vscode.Uri | undefined, uris: vscode.Uri[] | undefined): vscode.Uri[] {
  const all = uris && uris.length > 0 ? uris : uri ? [uri] : [];
  return all.filter((candidate) => candidate.scheme === 'calagopus');
}

async function compress(session: Session, operations: FileOperationTracker, targets: vscode.Uri[]): Promise<void> {
  const root = dirname(targets[0].path);
  if (targets.some((target) => dirname(target.path) !== root)) {
    vscode.window.showErrorMessage('Calagopus: select files from a single folder to compress.');
    return;
  }

  const picked = await vscode.window.showQuickPick<FormatPick>(
    ARCHIVE_FORMATS.map((entry, index) => ({ label: entry.extension, description: entry.format, index })),
    { title: 'Calagopus: archive format' },
  );
  if (!picked) {
    return;
  }
  const { format, extension } = ARCHIVE_FORMATS[picked.index];

  const name = await vscode.window.showInputBox({
    title: 'Calagopus: archive name',
    value: generateArchiveName(extension),
    validateInput: (value) => (value.trim().length === 0 ? 'The archive needs a name.' : undefined),
  });
  if (!name) {
    return;
  }

  const ref = refOf(targets[0]);
  try {
    const client = await session.client(ref.origin);
    const identifier = await client.compress(
      ref.server,
      root,
      targets.map((target) => basename(target.path)),
      format,
      name.trim(),
    );
    await operations.register(ref, identifier);
  } catch (err) {
    log.error(`compress ${root} failed: ${err}`);
    vscode.window.showErrorMessage(`Calagopus: could not create the archive: ${err}`);
  }
}

async function decompressOne(session: Session, operations: FileOperationTracker, target: vscode.Uri): Promise<void> {
  const ref = refOf(target);
  const client = await session.client(ref.origin);
  const identifier = await client.decompress(ref.server, dirname(target.path), target.path);
  await operations.register(ref, identifier);
}

async function decompress(session: Session, operations: FileOperationTracker, targets: vscode.Uri[]): Promise<void> {
  const results = await Promise.allSettled(targets.map((target) => decompressOne(session, operations, target)));

  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length === 0) {
    return;
  }

  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      log.error(`decompress ${targets[index].path} failed: ${result.reason}`);
    }
  }

  if (failures.length === results.length) {
    vscode.window.showErrorMessage(
      results.length === 1
        ? `Calagopus: could not extract the archive: ${failures[0].reason}`
        : `Calagopus: none of the ${results.length} archives could be extracted. See the Calagopus output channel.`,
    );
    return;
  }

  vscode.window.showErrorMessage(
    `Calagopus: ${failures.length} of ${results.length} archives could not be extracted. See the Calagopus output channel.`,
  );
}

async function permissions(session: Session, fs: CalagopusFileSystem, targets: vscode.Uri[]): Promise<void> {
  const root = dirname(targets[0].path);
  if (targets.some((target) => dirname(target.path) !== root)) {
    vscode.window.showErrorMessage('Calagopus: select files from a single folder to change permissions.');
    return;
  }

  const entries = await Promise.all(targets.map((target) => fs.entryFor(target)));
  const modes = new Set(entries.map((entry) => entry?.mode_bits ?? ''));
  const current = modes.size === 1 ? [...modes][0] : '';
  const symbolic = entries.length === 1 ? entries[0]?.mode : undefined;
  const hasDirectory = entries.some((entry) => entry?.directory);

  const mode = await vscode.window.showInputBox({
    title: 'Calagopus: file permissions',
    prompt: symbolic ? `Current: ${symbolic}` : 'Octal permissions, for example 755',
    value: current,
    validateInput: (value) =>
      /^[0-7]{3}$/.test(value.trim()) ? undefined : 'Enter exactly 3 octal digits, for example 755.',
  });
  if (!mode) {
    return;
  }

  let recursive = false;
  if (hasDirectory) {
    const picked = await vscode.window.showQuickPick(['No', 'Yes'], {
      title: 'Calagopus: apply recursively to folder contents?',
    });
    if (!picked) {
      return;
    }
    recursive = picked === 'Yes';
  }

  const ref = refOf(targets[0]);
  const files: ChmodFile[] = targets.map((target) => ({
    file: basename(target.path),
    mode: mode.trim(),
    recursive,
  }));

  try {
    const client = await session.client(ref.origin);
    const updated = await client.chmod(ref.server, root, files);
    fs.invalidatePath(ref, root);
    vscode.window.setStatusBarMessage(`Permissions updated on ${updated} ${updated === 1 ? 'file' : 'files'}`, 5000);
  } catch (err) {
    log.error(`chmod ${root} failed: ${err}`);
    vscode.window.showErrorMessage(`Calagopus: could not change permissions: ${err}`);
  }
}

export function registerFileActions(
  session: Session,
  operations: FileOperationTracker,
  fs: CalagopusFileSystem,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('calagopus.files.compress', (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const targets = selection(uri, uris);
      return targets.length > 0 ? compress(session, operations, targets) : undefined;
    }),

    vscode.commands.registerCommand('calagopus.files.decompress', (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const targets = selection(uri, uris);
      return targets.length > 0 ? decompress(session, operations, targets) : undefined;
    }),

    vscode.commands.registerCommand('calagopus.files.permissions', (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const targets = selection(uri, uris);
      return targets.length > 0 ? permissions(session, fs, targets) : undefined;
    }),
  ];
}
