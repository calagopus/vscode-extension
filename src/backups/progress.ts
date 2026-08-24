import * as vscode from 'vscode';
import type { BackupCompleted, BackupDeleted, BackupProgress } from '../api/types.ts';
import { formatBytes } from '../format.ts';
import type { CalagopusFileSystem, ServerRef } from '../fs/fileSystemProvider.ts';
import { log } from '../log.ts';
import { mountedServers, shortId, workspaceServers } from '../servers.ts';
import type { Session } from '../session.ts';
import type { WingsSocketHub, WingsSocketLease } from '../wings/socketHub.ts';

const STALE_MS = 5000;
const SWEEP_INTERVAL_MS = 2000;

interface Tracked {
  ref: ServerRef;
  label: string;
  lastPercent: number;
  lastTickAt: number;
  report: (value: { message?: string; increment?: number }) => void;
  finish: () => void;
}

function refKey(ref: ServerRef): string {
  return `${ref.origin}\0${ref.server}`;
}

function backupKey(ref: ServerRef, uuid: string): string {
  return `${refKey(ref)}\0backup\0${uuid}`;
}

function restoreKey(ref: ServerRef): string {
  return `${refKey(ref)}\0restore`;
}

function serverSuffix(ref: ServerRef): string {
  const mounted = mountedServers();
  if (mounted.length <= 1) {
    return '';
  }
  const match = mounted.find((s) => s.origin === ref.origin && s.uuid.toLowerCase() === ref.server.toLowerCase());
  return match ? ` on ${match.name}` : '';
}

function parse<T>(raw: string, what: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    log.debug(`backups: unparseable ${what} payload`);
    return null;
  }
}

function progressMessage(progress: BackupProgress): string {
  const parts: string[] = [];

  parts.push(
    progress.bytes_total > 1
      ? `${formatBytes(progress.bytes_processed)} / ${formatBytes(progress.bytes_total)}`
      : formatBytes(progress.bytes_processed),
  );
  if (progress.files_processed > 0) {
    parts.push(`${progress.files_processed} files`);
  }
  return parts.join(' • ');
}

export class BackupProgressTracker {
  private readonly tracked = new Map<string, Tracked>();
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
      lease.on('backup started', (uuid: string) => this.onBackupStarted(ref, uuid));
      lease.on('backup progress', (uuid: string, raw: string) => this.onBackupProgress(ref, uuid, raw));
      lease.on('backup completed', (uuid: string, raw: string) => this.onBackupCompleted(ref, uuid, raw));
      lease.on('backup deleted', (uuid: string, raw: string) => this.onBackupDeleted(ref, uuid, raw));
      lease.on('backup restore started', () => this.onRestoreStarted(ref));
      lease.on('backup restore progress', (raw: string) => this.onRestoreProgress(ref, raw));
      lease.on('backup restore completed', (successful: string) => this.onRestoreCompleted(ref, successful));
      this.leases.set(key, lease);
    }
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
    this.sessionSubscription.dispose();
    for (const lease of this.leases.values()) {
      lease.release();
    }
    this.leases.clear();
    for (const tracked of this.tracked.values()) {
      tracked.finish();
    }
    this.tracked.clear();
  }

  private onBackupStarted(ref: ServerRef, uuid: string): void {
    this.open(backupKey(ref, uuid), ref, `Creating backup ${shortId(uuid)}${serverSuffix(ref)}`);
  }

  private onBackupProgress(ref: ServerRef, uuid: string, raw: string): void {
    const progress = parse<BackupProgress>(raw, 'backup progress');
    if (progress) {
      this.advance(backupKey(ref, uuid), ref, `Creating backup ${shortId(uuid)}${serverSuffix(ref)}`, progress);
    }
  }

  private onBackupCompleted(ref: ServerRef, uuid: string, raw: string): void {
    this.close(backupKey(ref, uuid));

    const completed = parse<BackupCompleted>(raw, 'backup completed');
    if (!completed) {
      return;
    }

    if (completed.successful) {
      vscode.window.showInformationMessage(
        `Calagopus: backup ${shortId(uuid)}${serverSuffix(ref)} completed successfully.`,
      );
    } else {
      vscode.window.showErrorMessage(`Calagopus: backup ${shortId(uuid)}${serverSuffix(ref)} failed.`);
    }
  }

  private onBackupDeleted(ref: ServerRef, uuid: string, raw: string): void {
    const deleted = parse<BackupDeleted>(raw, 'backup deleted');
    if (deleted && !deleted.successful) {
      vscode.window.showErrorMessage(`Calagopus: deleting backup ${shortId(uuid)}${serverSuffix(ref)} failed.`);
    }
  }

  private onRestoreStarted(ref: ServerRef): void {
    this.open(restoreKey(ref), ref, `Restoring backup${serverSuffix(ref)}`);
  }

  private onRestoreProgress(ref: ServerRef, raw: string): void {
    const progress = parse<BackupProgress>(raw, 'backup restore progress');
    if (progress) {
      this.advance(restoreKey(ref), ref, `Restoring backup${serverSuffix(ref)}`, progress);
    }
  }

  private onRestoreCompleted(ref: ServerRef, successful: string): void {
    this.close(restoreKey(ref));
    this.fs.invalidateServer(ref);

    if (successful === 'true') {
      vscode.window.showInformationMessage(`Calagopus: backup restore${serverSuffix(ref)} completed successfully.`);
    } else {
      vscode.window.showErrorMessage(`Calagopus: backup restore${serverSuffix(ref)} failed.`);
    }
  }

  private open(key: string, ref: ServerRef, label: string): Tracked {
    const existing = this.tracked.get(key);
    if (existing) {
      existing.lastTickAt = Date.now();
      return existing;
    }

    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const tracked: Tracked = {
      ref,
      label,
      lastPercent: 0,
      lastTickAt: Date.now(),
      report: () => undefined,
      finish,
    };
    this.tracked.set(key, tracked);

    void vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Calagopus: ${label}` },
      (progress) => {
        tracked.report = (value) => progress.report(value);
        return done;
      },
    );

    return tracked;
  }

  private advance(key: string, ref: ServerRef, label: string, progress: BackupProgress): void {
    const tracked = this.open(key, ref, label);
    tracked.lastTickAt = Date.now();

    if (progress.bytes_total > 1) {
      const percent = Math.min(100, (progress.bytes_processed / progress.bytes_total) * 100);
      const increment = Math.max(0, percent - tracked.lastPercent);
      tracked.lastPercent = percent;
      tracked.report({ message: progressMessage(progress), increment });
    } else {
      tracked.report({ message: progressMessage(progress) });
    }
  }

  private close(key: string): void {
    const tracked = this.tracked.get(key);
    if (!tracked) {
      return;
    }
    tracked.finish();
    this.tracked.delete(key);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, tracked] of [...this.tracked]) {
      if (now - tracked.lastTickAt <= STALE_MS) {
        continue;
      }
      log.debug(`backups: dropping stale progress for ${tracked.label}`);
      this.close(key);
    }
  }
}
