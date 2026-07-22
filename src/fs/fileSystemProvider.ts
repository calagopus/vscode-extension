import * as vscode from 'vscode';
import { ApiError, type PanelClient } from '../api/client.ts';
import type { DirectoryEntry } from '../api/types.ts';
import type { CollabRegistry } from '../collab/collabManager.ts';
import { CollabConflictError } from '../collab/session.ts';
import { log } from '../log.ts';
import type { Session } from '../session.ts';
import type { SettingsCache } from '../settings.ts';

export interface ServerRef {
  origin: string;
  server: string;
}

// calagopus://<hex(origin)>.<server-uuid>/<path...>
export function serverUri(origin: string, server: string, path = '/'): vscode.Uri {
  const authority = `${encodeOrigin(origin)}.${server.toLowerCase()}`;
  return vscode.Uri.from({ scheme: 'calagopus', authority, path });
}

export function refOf(uri: vscode.Uri): ServerRef {
  return decodeAuthority(uri.authority);
}

function encodeOrigin(origin: string): string {
  return Buffer.from(new URL(origin).origin, 'utf8').toString('hex');
}

export function decodeAuthority(authority: string): ServerRef {
  const dot = authority.indexOf('.');
  if (dot < 0) {
    return { origin: '', server: authority };
  }
  let origin = '';
  try {
    origin = Buffer.from(authority.slice(0, dot), 'hex').toString('utf8');
  } catch {
    origin = '';
  }
  return { origin, server: authority.slice(dot + 1) };
}

function joinPath(directory: string, name: string): string {
  return directory === '/' ? `/${name}` : `${directory}/${name}`;
}

const CACHE_TTL_MS = 2_500;
const MAX_INLINE_WRITE_BYTES = 1024 * 1024;

interface CachedListing {
  at: number;
  entries: DirectoryEntry[];
}

function parentOf(path: string): { parent: string; name: string } {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return {
    parent: idx <= 0 ? '/' : trimmed.slice(0, idx),
    name: trimmed.slice(idx + 1),
  };
}

function toFileType(entry: DirectoryEntry): vscode.FileType {
  let type = entry.directory ? vscode.FileType.Directory : vscode.FileType.File;
  if (entry.symlink) {
    type |= vscode.FileType.SymbolicLink;
  }
  return type;
}

function translateError(err: unknown, uri: vscode.Uri): Error {
  if (err instanceof ApiError) {
    switch (err.status) {
      case 404:
        return vscode.FileSystemError.FileNotFound(uri);
      case 401:
      case 403:
        return vscode.FileSystemError.NoPermissions(uri);
      case 413:
        return vscode.FileSystemError.Unavailable(`${uri.path}: file exceeds the panel's maximum viewable size`);
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}

export class CalagopusFileSystem implements vscode.FileSystemProvider {
  private readonly cache = new Map<string, CachedListing>();

  private readonly didChangeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.didChangeEmitter.event;

  constructor(
    private readonly session: Session,
    private readonly settings: SettingsCache,
    private readonly collab?: CollabRegistry,
  ) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => null);
  }

  private cacheKey(ref: ServerRef, directory: string): string {
    return `${ref.origin}\0${ref.server}\0${directory}`;
  }

  private async listCached(ref: ServerRef, directory: string): Promise<DirectoryEntry[]> {
    const key = this.cacheKey(ref, directory);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return hit.entries;
    }

    log.trace(`fs list ${key}`);
    const client = await this.session.client(ref.origin);
    const entries = await client.listDirectory(ref.server, directory);
    this.cache.set(key, { at: Date.now(), entries });
    return entries;
  }

  private async lookup(uri: vscode.Uri): Promise<DirectoryEntry | null> {
    const { parent, name } = parentOf(uri.path);
    try {
      const entries = await this.listCached(refOf(uri), parent);
      return entries.find((e) => e.name === name) ?? null;
    } catch {
      return null;
    }
  }

  private invalidate(ref: ServerRef, directory: string) {
    this.cache.delete(this.cacheKey(ref, directory));
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    if (uri.path === '/' || uri.path === '') {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }

    const { parent, name } = parentOf(uri.path);
    try {
      const entries = await this.listCached(refOf(uri), parent);
      const entry = entries.find((e) => e.name === name);
      if (!entry) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }

      return {
        type: toFileType(entry),
        ctime: Date.parse(entry.created) || 0,
        mtime: Date.parse(entry.modified) || 0,
        size: entry.size,
      };
    } catch (err) {
      throw translateError(err, uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    try {
      const entries = await this.listCached(refOf(uri), uri.path || '/');
      return entries.map((entry) => [entry.name, toFileType(entry)]);
    } catch (err) {
      throw translateError(err, uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    log.trace(`fs read ${uri.toString()}`);

    const { origin, server } = refOf(uri);
    const [entry, settings] = await Promise.all([this.lookup(uri), this.settings.tryGet(origin)]);
    const tooBigToView = !!(entry && settings && entry.size > settings.server.max_file_manager_view_size);

    try {
      const client = await this.session.client(origin);
      if (tooBigToView) {
        const { parent, name } = parentOf(uri.path);
        return await client.downloadFile(server, parent, name);
      }
      return await client.readFile(server, uri.path);
    } catch (err) {
      log.error(`fs read ${uri.toString()} failed: ${err}`);
      throw translateError(err, uri);
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    if (this.collab?.shouldSkipSave(uri)) {
      return;
    }

    const ref = refOf(uri);
    const { parent, name } = parentOf(uri.path);

    let exists = false;
    try {
      const entries = await this.listCached(ref, parent);
      exists = entries.some((e) => e.name === name);
    } catch {
      // parent unknown
    }

    if (exists && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }
    if (!exists && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    if (this.collab?.hasSession(uri)) {
      try {
        await this.collab.saveViaCollab(uri);
        this.invalidate(ref, parent);
        this.didChangeEmitter.fire([
          { type: exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri },
        ]);
        return;
      } catch (err) {
        // A conflict must never fall back to a REST write — that would
        // silently overwrite the external disk edit the daemon just rejected
        // the save to protect. Keep the document dirty instead.
        if (err instanceof CollabConflictError) {
          throw err;
        }
        log.warn(`fs write ${uri.toString()}: collab save failed, falling back to REST: ${err}`);
      }
    }

    try {
      const client = await this.session.client(ref.origin);

      if (content.byteLength > MAX_INLINE_WRITE_BYTES) {
        await client.uploadFile(ref.server, parent, name, content);
      } else {
        await client.writeFile(ref.server, uri.path, content);
      }
    } catch (err) {
      log.error(`fs write ${uri.toString()} failed: ${err}`);
      throw translateError(err, uri);
    }

    this.invalidate(ref, parent);
    this.didChangeEmitter.fire([
      {
        type: exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created,
        uri,
      },
    ]);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const ref = refOf(uri);
    const { parent, name } = parentOf(uri.path);
    try {
      const client = await this.session.client(ref.origin);
      await client.createDirectory(ref.server, parent, name);
    } catch (err) {
      throw translateError(err, uri);
    }

    this.invalidate(ref, parent);
    this.didChangeEmitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }

  async delete(uri: vscode.Uri): Promise<void> {
    const ref = refOf(uri);
    const { parent } = parentOf(uri.path);
    try {
      const client = await this.session.client(ref.origin);
      await client.delete(ref.server, [uri.path]);
    } catch (err) {
      throw translateError(err, uri);
    }

    this.invalidate(ref, parent);
    this.invalidate(ref, uri.path);
    this.didChangeEmitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    const oldRef = refOf(oldUri);
    const newRef = refOf(newUri);
    if (oldUri.authority !== newUri.authority) {
      throw vscode.FileSystemError.Unavailable('Cannot rename across servers.');
    }

    if (!options.overwrite) {
      const { parent, name } = parentOf(newUri.path);
      try {
        const entries = await this.listCached(newRef, parent);
        if (entries.some((e) => e.name === name)) {
          throw vscode.FileSystemError.FileExists(newUri);
        }
      } catch (err) {
        if (err instanceof vscode.FileSystemError && err.code === 'FileExists') {
          throw err;
        }
      }
    }

    try {
      const client = await this.session.client(oldRef.origin);
      await client.rename(oldRef.server, oldUri.path, newUri.path);
    } catch (err) {
      throw translateError(err, oldUri);
    }

    this.invalidate(oldRef, parentOf(oldUri.path).parent);
    this.invalidate(newRef, parentOf(newUri.path).parent);
    this.didChangeEmitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }

  async copy(source: vscode.Uri, destination: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    if (source.scheme !== 'calagopus' || destination.scheme !== 'calagopus') {
      throw vscode.FileSystemError.Unavailable('Only calagopus:// URIs are supported.');
    }

    const srcRef = refOf(source);
    const destRef = refOf(destination);
    const { parent: srcParent, name: srcName } = parentOf(source.path);
    const { parent: destParent, name: destName } = parentOf(destination.path);

    let destExists = false;
    try {
      const entries = await this.listCached(destRef, destParent);
      destExists = entries.some((e) => e.name === destName);
    } catch {
      // destination parent unknown
    }
    if (destExists && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(destination);
    }

    try {
      const srcClient = await this.session.client(srcRef.origin);
      const destClient = destRef.origin === srcRef.origin ? srcClient : await this.session.client(destRef.origin);

      if (destExists) {
        await destClient.delete(destRef.server, [destination.path]);
      }

      if (srcRef.origin !== destRef.origin) {
        const entry = await this.lookup(source);
        await this.pipeAcrossOrigins(
          srcClient,
          srcRef.server,
          destClient,
          destRef.server,
          source.path,
          destination.path,
          entry?.directory ?? false,
        );
      } else if (srcRef.server === destRef.server) {
        if (srcParent === destParent) {
          await srcClient.copy(srcRef.server, source.path, destName);
        } else {
          await this.copyViaTemp(srcClient, srcRef.server, source.path, srcParent, destination.path);
        }
      } else {
        await srcClient.copyRemote(
          srcRef.server,
          srcParent,
          [{ from: srcName, to: destName }],
          destParent,
          destRef.server,
        );
      }
    } catch (err) {
      log.error(`fs copy ${source.toString()} -> ${destination.toString()} failed: ${err}`);
      throw translateError(err, destination);
    }

    this.invalidate(srcRef, srcParent);
    this.invalidate(destRef, destParent);
    this.didChangeEmitter.fire([{ type: vscode.FileChangeType.Created, uri: destination }]);
  }

  private async pipeAcrossOrigins(
    srcClient: PanelClient,
    srcServer: string,
    destClient: PanelClient,
    destServer: string,
    srcPath: string,
    destPath: string,
    isDirectory: boolean,
  ): Promise<void> {
    if (!isDirectory) {
      const src = parentOf(srcPath);
      const dest = parentOf(destPath);
      const bytes = await srcClient.downloadFile(srcServer, src.parent, src.name);
      await destClient.uploadFile(destServer, dest.parent, dest.name, bytes);
      return;
    }

    const dest = parentOf(destPath);
    await destClient.createDirectory(destServer, dest.parent, dest.name);

    const entries = await srcClient.listDirectory(srcServer, srcPath);
    for (const child of entries) {
      await this.pipeAcrossOrigins(
        srcClient,
        srcServer,
        destClient,
        destServer,
        joinPath(srcPath, child.name),
        joinPath(destPath, child.name),
        child.directory,
      );
    }
  }

  private async copyViaTemp(
    client: PanelClient,
    server: string,
    sourcePath: string,
    srcParent: string,
    destPath: string,
  ): Promise<void> {
    const tempName = `.calagopus-copy-${Date.now()}`;
    const tempPath = joinPath(srcParent, tempName);
    await client.copy(server, sourcePath, tempName);
    try {
      await client.rename(server, tempPath, destPath);
    } catch (err) {
      await client.delete(server, [tempPath]).catch(() => undefined);
      throw err;
    }
  }
}
