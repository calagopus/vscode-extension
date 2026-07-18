import type {
  Account,
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

  async getFileRevisionContent(server: string, revision: number): Promise<Uint8Array> {
    const response = await this.request(`/api/client/servers/${server}/files/revisions/${revision}`);
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
    const baseUrl = await this.getUploadUrl(server, directory);
    const total = content.byteLength;

    if (total <= UPLOAD_CHUNK_BYTES) {
      await this.uploadChunk(baseUrl, name, content);
      return;
    }

    let offset = 0;
    let continuationToken: string | undefined;
    while (offset < total) {
      const end = Math.min(offset + UPLOAD_CHUNK_BYTES, total);
      const isLast = end >= total;

      const url = new URL(baseUrl);
      if (!isLast) {
        url.searchParams.set('wants_continue', '0');
      }
      if (continuationToken !== undefined) {
        url.searchParams.set('continuation_token', continuationToken);
      }

      const token = await this.uploadChunk(url.toString(), name, content.subarray(offset, end));
      if (!isLast) {
        if (!token) {
          throw new ApiError(500, 'wings did not return a continuation token for a non-final chunk');
        }
        continuationToken = token;
      }
      offset = end;
    }
  }

  private async uploadChunk(url: string, name: string, content: Uint8Array): Promise<string | null> {
    const form = new FormData();
    form.append('files', new Blob([content]), name);

    const response = await fetch(url, { method: 'POST', body: form, headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw await apiError(response);
    }

    try {
      const body = (await response.json()) as { continuation_token?: string };
      return body.continuation_token ?? null;
    } catch {
      return null;
    }
  }

  async copy(server: string, path: string, name: string): Promise<void> {
    await this.request(`/api/client/servers/${server}/files/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, destination: name, foreground: true }),
    });
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
}
