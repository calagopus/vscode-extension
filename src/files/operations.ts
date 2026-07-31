import * as vscode from 'vscode';
import type { FileOperation } from '../api/types.ts';
import { formatBytes } from '../format.ts';
import type { CalagopusFileSystem, ServerRef } from '../fs/fileSystemProvider.ts';
import { log } from '../log.ts';
import { basename, dirname } from '../paths.ts';
import { workspaceServers } from '../servers.ts';
import type { Session } from '../session.ts';
import type { WingsSocketHub, WingsSocketLease } from '../wings/socketHub.ts';

const STALE_MS = 5000;
const SWEEP_INTERVAL_MS = 2000;
const TOMBSTONE_MS = 60000;
const REGISTER_GRACE_MS = 15000;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

interface Awaiter {
  deferred: Deferred;
  registeredAt: number;
}

interface Tombstone {
  error?: string;
  recordedAt: number;
}

interface TrackedOp {
  ref: ServerRef;
  uuid: string;
  operation: FileOperation;
  local: boolean;
  lastPercent: number;
  lastTickAt: number;
  report: (value: { message?: string; increment?: number }) => void;
  finish: () => void;
}

function refKey(ref: ServerRef): string {
  return `${ref.origin}\0${ref.server}`;
}

function opKey(ref: ServerRef, uuid: string): string {
  return `${refKey(ref)}\0${uuid}`;
}

function createDeferred(): Deferred {
  let resolve: () => void = () => undefined;
  let reject: (err: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function titleFor(operation: FileOperation): string {
  switch (operation.type) {
    case 'compress':
      return `Compressing to ${basename(operation.destination_path ?? 'archive')}`;
    case 'decompress':
      return `Extracting ${basename(operation.path ?? 'archive')}`;
    case 'pull':
      return `Downloading to ${basename(operation.destination_path ?? '/')}`;
    case 'copy':
    case 'copy_many':
    case 'copy_remote':
      return 'Copying files';
    case 'export_backup':
      return 'Exporting backup';
  }
}

function progressMessage(operation: FileOperation, local: boolean): string {
  const parts: string[] = [];
  parts.push(
    operation.bytes_total > 0
      ? `${formatBytes(operation.bytes_processed)} / ${formatBytes(operation.bytes_total)}`
      : formatBytes(operation.bytes_processed),
  );
  if (operation.files_processed !== undefined) {
    parts.push(`${operation.files_processed} files`);
  }
  if (!local) {
    parts.push('started elsewhere');
  }
  return parts.join(' • ');
}

function affectedDirectories(operation: FileOperation): string[] {
  const dirs = new Set<string>();
  for (const path of [operation.path, operation.destination_path]) {
    if (!path) {
      continue;
    }
    dirs.add(path);
    dirs.add(dirname(path));
  }
  return [...dirs];
}

export class FileOperationTracker {
  private readonly ops = new Map<string, TrackedOp>();
  private readonly awaited = new Map<string, Awaiter>();
  private readonly tombstones = new Map<string, Tombstone>();
  private readonly local = new Set<string>();
  private readonly leases = new Map<string, WingsSocketLease>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private readonly sessionSubscription: vscode.Disposable;

  constructor(
    private readonly hub: WingsSocketHub,
    private readonly session: Session,
    private readonly fs: CalagopusFileSystem,
  ) {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sessionSubscription = session.onDidChange(() => void this.sync());
    void this.sync();
  }

  async sync(): Promise<void> {
    const wanted = new Map<string, ServerRef>();
    for (const ref of workspaceServers()) {
      if (await this.session.clientIfSignedIn(ref.origin)) {
        wanted.set(refKey(ref), ref);
      }
    }

    for (const [key, lease] of [...this.leases]) {
      if (!wanted.has(key)) {
        lease.release();
        this.leases.delete(key);
      }
    }

    for (const [key, ref] of wanted) {
      if (this.leases.has(key)) {
        continue;
      }
      const lease = this.hub.acquire(ref.origin, ref.server);
      lease.on('operation progress', (uuid: string, raw: string) => this.onProgress(ref, uuid, raw));
      lease.on('operation completed', (uuid: string) => this.settle(ref, uuid));
      lease.on('operation error', (uuid: string, message: string) => this.settle(ref, uuid, message));
      this.leases.set(key, lease);
    }
  }

  register(ref: ServerRef, identifier: string): Promise<void> {
    const key = opKey(ref, identifier);

    const tombstone = this.tombstones.get(key);
    if (tombstone) {
      this.tombstones.delete(key);
      return tombstone.error === undefined ? Promise.resolve() : Promise.reject(new Error(tombstone.error));
    }

    this.local.add(key);

    const tracked = this.ops.get(key);
    if (tracked) {
      tracked.local = true;
    }

    let awaiter = this.awaited.get(key);
    if (!awaiter) {
      awaiter = { deferred: createDeferred(), registeredAt: Date.now() };
      this.awaited.set(key, awaiter);
    }
    return awaiter.deferred.promise;
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
    this.sessionSubscription.dispose();
    for (const lease of this.leases.values()) {
      lease.release();
    }
    this.leases.clear();
    for (const tracked of this.ops.values()) {
      tracked.finish();
    }
    this.ops.clear();
    for (const awaiter of this.awaited.values()) {
      awaiter.deferred.resolve();
    }
    this.awaited.clear();
    this.local.clear();
    this.tombstones.clear();
  }

  private onProgress(ref: ServerRef, uuid: string, raw: string): void {
    let operation: FileOperation;
    try {
      operation = JSON.parse(raw) as FileOperation;
    } catch {
      log.debug(`operations: unparseable progress payload for ${uuid}`);
      return;
    }

    const key = opKey(ref, uuid);
    let tracked = this.ops.get(key);
    if (!tracked) {
      tracked = this.open(key, ref, uuid, operation);
    }

    tracked.operation = operation;
    tracked.lastTickAt = Date.now();

    if (operation.bytes_total > 0) {
      const percent = Math.min(100, (operation.bytes_processed / operation.bytes_total) * 100);
      const increment = Math.max(0, percent - tracked.lastPercent);
      tracked.lastPercent = percent;
      tracked.report({ message: progressMessage(operation, tracked.local), increment });
    } else {
      tracked.report({ message: progressMessage(operation, tracked.local) });
    }
  }

  private open(key: string, ref: ServerRef, uuid: string, operation: FileOperation): TrackedOp {
    const done = createDeferred();

    const tracked: TrackedOp = {
      ref,
      uuid,
      operation,
      local: this.local.has(key),
      lastPercent: 0,
      lastTickAt: Date.now(),
      report: () => undefined,
      finish: done.resolve,
    };
    this.ops.set(key, tracked);

    void vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Calagopus: ${titleFor(operation)}`,
        cancellable: true,
      },
      (progress, token) => {
        tracked.report = (value) => progress.report(value);
        token.onCancellationRequested(() => void this.cancel(key));
        return done.promise;
      },
    );

    return tracked;
  }

  private teardown(key: string, ref: ServerRef): Awaiter | undefined {
    const tracked = this.ops.get(key);

    if (tracked) {
      tracked.finish();
      this.ops.delete(key);
      for (const directory of affectedDirectories(tracked.operation)) {
        this.fs.invalidatePath(ref, directory);
      }
    }

    this.local.delete(key);
    const awaiter = this.awaited.get(key);
    this.awaited.delete(key);
    return awaiter;
  }

  private settle(ref: ServerRef, uuid: string, error?: string): void {
    const key = opKey(ref, uuid);
    const awaiter = this.teardown(key, ref);

    if (error === undefined) {
      awaiter?.deferred.resolve();
    } else if (awaiter) {
      awaiter.deferred.reject(new Error(error));
    } else {
      vscode.window.showErrorMessage(`Calagopus: ${error}`);
    }

    this.tombstones.set(key, { error, recordedAt: Date.now() });
  }

  private abandon(ref: ServerRef, uuid: string): void {
    const key = opKey(ref, uuid);
    const awaiter = this.teardown(key, ref);
    awaiter?.deferred.reject(new Error('lost contact with the server while the operation was running'));
  }

  private sweep(): void {
    const now = Date.now();
    for (const tracked of [...this.ops.values()]) {
      if (now - tracked.lastTickAt <= STALE_MS) {
        continue;
      }
      log.debug(`operations: dropping stale operation ${tracked.uuid}`);
      this.abandon(tracked.ref, tracked.uuid);
    }

    for (const [key, awaiter] of [...this.awaited]) {
      if (this.ops.has(key) || now - awaiter.registeredAt <= REGISTER_GRACE_MS) {
        continue;
      }
      log.debug('operations: no progress ever arrived for a registered operation');
      this.awaited.delete(key);
      this.local.delete(key);
      awaiter.deferred.reject(new Error('lost track of the operation'));
    }

    for (const [key, tombstone] of this.tombstones) {
      if (now - tombstone.recordedAt > TOMBSTONE_MS) {
        this.tombstones.delete(key);
      }
    }
  }

  private async cancel(key: string): Promise<void> {
    const tracked = this.ops.get(key);
    if (!tracked) {
      return;
    }
    try {
      const client = await this.session.client(tracked.ref.origin);
      await client.cancelFileOperation(tracked.ref.server, tracked.uuid);
    } catch (err) {
      log.warn(`operations: cancel ${tracked.uuid} failed: ${err}`);
      vscode.window.showErrorMessage(`Calagopus: could not cancel the operation: ${err}`);
    }
  }
}
