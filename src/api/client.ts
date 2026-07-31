import type {
  Account,
  ArchiveFormat,
  ChmodFile,
  CommandSnippet,
  CopyFile,
  DirectoryEntry,
  DirectoryListResponse,
  FileRevision,
  FileSearchFilters,
  Pagination,
  PowerAction,
  PublicSettings,
  Server,
  ServerListResponse,
  WebsocketCredentials,
} from './types.ts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiError(response: Response): Promise<ApiError> {
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: unknown; errors?: unknown[] };
    if (typeof body.error === 'string') {
      message = body.error;
    } else if (Array.isArray(body.errors) && typeof body.errors[0] === 'string') {
      message = body.errors[0];
    }
  } catch {
    // not json
  }
  return new ApiError(response.status, message);
}

export interface Credentials {
  origin: string;
  apiKey: string;
}

export type ReauthHandler = (client: PanelClient) => Promise<boolean>;

export const UPLOAD_CHUNK_BYTES = 95 * 1024 * 1024;
const UPLOAD_RECOVERY_LIMIT = 3;

function parseUploadOffset(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const offset = Number(value.trim());
  return Number.isInteger(offset) && offset >= 0 ? offset : null;
}

export class PanelClient {
  readonly origin: string;
  private apiKey: string;

  constructor(
    credentials: Credentials,
    private readonly reauth?: ReauthHandler,
  ) {
    this.origin = credentials.origin;
    this.apiKey = credentials.apiKey;
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  private async request(path: string, init: RequestInit = {}, allowReauth = true): Promise<Response> {
    const response = await fetch(`${this.origin}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        ...init.headers,
      },
    });

    if (response.status === 401 && allowReauth && this.reauth && (await this.reauth(this))) {
      return this.request(path, init, false);
    }

    if (!response.ok) {
      throw await apiError(response);
    }

    return response;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init);
    return (await response.json()) as T;
  }

  async ping(): Promise<void> {
    await this.request('/api/client/servers?per_page=1');
  }

  async getPublicSettings(): Promise<PublicSettings> {
    return this.json<PublicSettings>('/api/settings');
  }

  async getAccount(): Promise<Account> {
    const { user } = await this.json<{ user: Account }>('/api/client/account');
    return user;
  }

  private async fetchAll<R, T>(buildPath: (page: number) => string, select: (body: R) => Pagination<T>): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const pag = select(await this.json<R>(buildPath(page)));
      items.push(...pag.data);
      if (page * pag.per_page >= pag.total || pag.data.length === 0) {
        return items;
      }
    }
  }

  async listServers(search?: string): Promise<Server[]> {
    return this.fetchAll(
      (page) => {
        const params = new URLSearchParams({ page: `${page}`, per_page: '100' });
        if (search) params.set('search', search);
        return `/api/client/servers?${params}`;
      },
      (body: ServerListResponse) => body.servers,
    );
  }

  async getServer(uuid: string): Promise<Server> {
    const { server } = await this.json<{ server: Server }>(`/api/client/servers/${uuid}`);
    return server;
  }

  async listDirectory(server: string, directory: string): Promise<DirectoryEntry[]> {
    return this.fetchAll(
      (page) => {
        const params = new URLSearchParams({ directory, page: `${page}`, per_page: '100', sort: 'name_asc' });
        return `/api/client/servers/${server}/files/list?${params}`;
      },
      (body: DirectoryListResponse) => body.entries,
    );
  }

  async readFile(server: string, file: string): Promise<Uint8Array> {
    const params = new URLSearchParams({ file });
    const response = await this.request(`/api/client/servers/${server}/files/contents?${params}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  private async getDownloadUrl(server: string, directory: string, name: string): Promise<string> {
    const params = new URLSearchParams({ root: directory, directory: 'false' });
    params.append('files', name);
    const { url } = await this.json<{ url: string }>(`/api/client/servers/${server}/files/download?${params}`);
    return url;
  }

  async downloadFile(server: string, directory: string, name: string): Promise<Uint8Array> {
    const url = await this.getDownloadUrl(server, directory, name);

    const response = await fetch(url, { headers: { Accept: 'application/octet-stream' } });
    if (!response.ok) {
      throw await apiError(response);
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  async getFileRevisions(server: string, file: string): Promise<FileRevision[]> {
    const params = new URLSearchParams({ file });
    const { revisions } = await this.json<{ revisions: FileRevision[] }>(
      `/api/client/servers/${server}/files/revisions?${params}`,
    );
    return revisions;
  }

  async getFileRevisionContent(server: string, revision: number, file: string): Promise<Uint8Array> {
    const params = new URLSearchParams({ file });
    const response = await this.request(`/api/client/servers/${server}/files/revisions/${revision}?${params}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async writeFile(server: string, file: string, content: Uint8Array): Promise<void> {
    const params = new URLSearchParams({ file });
    await this.request(`/api/client/servers/${server}/files/write?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: Buffer.from(content),
    });
  }

  private async getUploadUrl(server: string, directory: string): Promise<string> {
    const { url } = await this.json<{ url: string }>(`/api/client/servers/${server}/files/upload`);
    return `${url}&directory=${encodeURIComponent(directory)}`;
  }

  async uploadFile(server: string, directory: string, name: string, content: Uint8Array): Promise<void> {
    const total = content.byteLength;

    if (total <= UPLOAD_CHUNK_BYTES) {
      const url = `${await this.getUploadUrl(server, directory)}&total_size=${total}`;
      await this.postUpload(url, name, content);
      return;
    }

    await this.resumableUpload(server, directory, name, content);
  }

  private async postUpload(url: string, name: string, content: Uint8Array): Promise<void> {
    const form = new FormData();
    form.append('files', new Blob([content]), name);

    const response = await fetch(url, { method: 'POST', body: form, headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw await apiError(response);
    }
  }

  private async resumableUpload(server: string, directory: string, name: string, content: Uint8Array): Promise<void> {
    const total = content.byteLength;
    const path = directory === '/' ? `/${name}` : `${directory}/${name}`;
    const refreshUrl = async () => `${await this.getUploadUrl(server, directory)}&file=${encodeURIComponent(name)}`;

    let url = await refreshUrl();

    if ((await this.headUploadOffset(url)) !== 0) {
      await this.delete(server, [path]);
      url = await refreshUrl();
    }

    let offset = 0;
    let recoveries = 0;
    while (offset < total) {
      const sliceStart = offset;
      const end = Math.min(sliceStart + UPLOAD_CHUNK_BYTES, total);
      const isLast = end >= total;

      const response = await fetch(url, {
        method: 'PATCH',
        body: content.subarray(sliceStart, end),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/offset+octet-stream',
          'Upload-Offset': String(sliceStart),
          'Upload-Length': String(total),
          ...(isLast ? { 'Upload-Complete': '?1' } : {}),
        },
      });

      if (response.ok) {
        offset = parseUploadOffset(response.headers.get('Upload-Offset')) ?? end;
        recoveries = 0;
        continue;
      }

      if (response.status === 401 && recoveries < UPLOAD_RECOVERY_LIMIT) {
        recoveries++;
        url = await refreshUrl();
        continue;
      }

      if (response.status === 409 && recoveries < UPLOAD_RECOVERY_LIMIT) {
        const resumed = parseUploadOffset(response.headers.get('Upload-Offset'));
        if (resumed !== null && resumed <= total) {
          recoveries++;
          offset = resumed;
          continue;
        }
      }

      throw await apiError(response);
    }
  }

  private async headUploadOffset(url: string): Promise<number> {
    const response = await fetch(url, { method: 'HEAD' });
    if (!response.ok) {
      return 0;
    }
    return parseUploadOffset(response.headers.get('Upload-Offset')) ?? 0;
  }

  async copyRemote(
    server: string,
    root: string,
    files: CopyFile[],
    destination: string,
    destinationServer: string,
  ): Promise<void> {
    await this.request(`/api/client/servers/${server}/files/copy-remote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        root,
        files,
        destination,
        destination_server: destinationServer,
        foreground: true,
      }),
    });
  }

  async createDirectory(server: string, root: string, name: string): Promise<void> {
    await this.request(`/api/client/servers/${server}/files/create-directory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, name }),
    });
  }

  async rename(server: string, from: string, to: string): Promise<void> {
    await this.request(`/api/client/servers/${server}/files/rename`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: '/', files: [{ from, to }] }),
    });
  }

  async delete(server: string, files: string[]): Promise<void> {
    await this.request(`/api/client/servers/${server}/files/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: '/', files }),
    });
  }

  async searchFiles(server: string, filters: FileSearchFilters): Promise<DirectoryEntry[]> {
    const body = await this.json<{ entries: DirectoryEntry[] }>(`/api/client/servers/${server}/files/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(filters),
    });
    return body.entries;
  }

  async compress(server: string, root: string, files: string[], format: ArchiveFormat, name?: string): Promise<string> {
    const { identifier } = await this.json<{ identifier: string }>(`/api/client/servers/${server}/files/compress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, files, format, name, foreground: false }),
    });
    return identifier;
  }

  async decompress(server: string, root: string, file: string): Promise<string> {
    const { identifier } = await this.json<{ identifier: string }>(`/api/client/servers/${server}/files/decompress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, file, foreground: false }),
    });
    return identifier;
  }

  async chmod(server: string, root: string, files: ChmodFile[]): Promise<number> {
    const { updated } = await this.json<{ updated: number }>(`/api/client/servers/${server}/files/chmod`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, files }),
    });
    return updated;
  }

  async copyMany(
    server: string,
    root: string,
    files: CopyFile[],
    overwrite: boolean,
  ): Promise<{ identifier: string; skipped: DirectoryEntry[] }> {
    return this.json<{ identifier: string; skipped: DirectoryEntry[] }>(
      `/api/client/servers/${server}/files/copy-many`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, files, overwrite, foreground: false }),
      },
    );
  }

  async cancelFileOperation(server: string, operation: string): Promise<void> {
    await this.request(`/api/client/servers/${server}/files/operations/${operation}`, { method: 'DELETE' });
  }

  async getWebsocketCredentials(server: string): Promise<WebsocketCredentials> {
    return this.json<WebsocketCredentials>(`/api/client/servers/${server}/websocket`);
  }

  async sendPowerAction(server: string, action: PowerAction): Promise<void> {
    await this.request(`/api/client/servers/${server}/power`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
  }

  async listCommandSnippets(): Promise<CommandSnippet[]> {
    return this.fetchAll(
      (page) => `/api/client/account/command-snippets?page=${page}&per_page=100`,
      (body: { command_snippets: Pagination<CommandSnippet> }) => body.command_snippets,
    );
  }

  async createCommandSnippet(name: string, command: string, eggs: string[]): Promise<CommandSnippet> {
    const { command_snippet } = await this.json<{ command_snippet: CommandSnippet }>(
      '/api/client/account/command-snippets',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, command, eggs }),
      },
    );
    return command_snippet;
  }

  async updateCommandSnippet(uuid: string, name: string, command: string, eggs: string[]): Promise<void> {
    await this.request(`/api/client/account/command-snippets/${uuid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, command, eggs }),
    });
  }

  async deleteCommandSnippet(uuid: string): Promise<void> {
    await this.request(`/api/client/account/command-snippets/${uuid}`, { method: 'DELETE' });
  }
}
