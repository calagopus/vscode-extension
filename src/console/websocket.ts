import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { WebsocketCredentials } from '../api/types.ts';
import { log } from '../log.ts';
import type { Session } from '../session.ts';

export class ConsoleSocket extends EventEmitter {
  private socket: WebSocket | null = null;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private refreshingToken = false;
  private tokenRefreshAttempts = 0;
  private tokenRefreshTimer: NodeJS.Timeout | null = null;
  private lastTokenRefreshAt = 0;
  private authGapped = false;

  private readonly minBackoffMs = 1_000;
  private readonly maxBackoffMs = 20_000;
  private readonly maxTokenRefreshAttempts = 3;
  private readonly tokenRefreshCooldownMs = 5_000;

  constructor(
    private readonly session: Session,
    private readonly origin: string,
    private readonly server: string,
  ) {
    super();
  }

  async connect(): Promise<void> {
    this.closed = false;
    await this.createSocket();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    this.socket?.close(1000, 'client closing');
    this.socket = null;
  }

  send(event: string, args: string[] = []): void {
    if (this.authGapped && event !== 'auth') {
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ event, args }));
    }
  }

  sendCommand(command: string): void {
    this.send('send command', [command]);
  }

  private async createSocket(): Promise<void> {
    let credentials: WebsocketCredentials;
    try {
      const client = await this.session.client(this.origin);
      credentials = await client.getWebsocketCredentials(this.server);
    } catch (err) {
      this.emit('CONNECTION_ERROR', err instanceof Error ? err : new Error(String(err)));
      this.scheduleReconnect();
      return;
    }

    this.emit('CONNECTION_STATE', this.reconnectAttempts === 0 ? 'connecting' : 'reconnecting');

    const socket = new WebSocket(credentials.url, {
      origin: new URL(credentials.url).origin,
    });
    this.socket = socket;

    socket.on('open', () => {
      log.debug(`ws [${this.server}] connected`);
      this.reconnectAttempts = 0;
      this.tokenRefreshAttempts = 0;
      this.authGapped = false;
      this.emit('CONNECTION_STATE', 'connected');
      socket.send(JSON.stringify({ event: 'auth', args: [credentials.token] }));
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        return;
      }

      let event: string;
      let args: string[];
      try {
        ({ event, args } = JSON.parse(data.toString()) as { event: string; args: string[] });
      } catch {
        return;
      }

      switch (event) {
        case 'auth success':
          this.tokenRefreshAttempts = 0;
          this.authGapped = false;
          break;
        case 'token expiring':
          void this.refreshToken();
          break;
        case 'token expired':
          this.authGapped = true;
          this.emit('AUTH_GAP');
          void this.refreshToken();
          break;
        case 'jwt error':
          if (!(args?.[0] ?? '').toLowerCase().includes('token')) {
            this.emit('CONNECTION_ERROR', new Error(`Error from daemon: ${args?.[0]}`));
            break;
          }

          this.authGapped = true;
          this.emit('AUTH_GAP');
          void this.refreshToken();
          break;
      }

      this.emit(event, ...(args ?? []));
    });

    socket.on('close', (code, reason) => {
      log.debug(`ws [${this.server}] closed: ${code} ${reason}`);
      if (this.socket === socket) {
        this.socket = null;
      }
      if (this.closed) {
        return;
      }

      this.emit('CONNECTION_STATE', 'disconnected');
      if (reason.toString() === 'permission revoked') {
        this.emit('CONNECTION_ERROR', new Error('Websocket permission revoked.'));
        this.closed = true;
        return;
      }

      this.scheduleReconnect();
    });

    socket.on('error', (err) => {
      this.emit('CONNECTION_ERROR', err);
    });
  }

  private async refreshToken(): Promise<void> {
    if (this.closed || this.refreshingToken || this.tokenRefreshTimer) {
      return;
    }

    const sinceLast = Date.now() - this.lastTokenRefreshAt;
    if (sinceLast < this.tokenRefreshCooldownMs) {
      this.scheduleTokenRefresh(this.tokenRefreshCooldownMs - sinceLast);
      return;
    }

    this.tokenRefreshAttempts++;
    if (this.tokenRefreshAttempts > this.maxTokenRefreshAttempts) {
      this.emit('CONNECTION_ERROR', new Error('Unable to reauthenticate with the daemon, reconnecting.'));
      this.socket?.close(1000, 'token refresh failed');
      return;
    }

    this.refreshingToken = true;
    this.lastTokenRefreshAt = Date.now();
    try {
      const client = await this.session.client(this.origin);
      const credentials = await client.getWebsocketCredentials(this.server);
      this.send('auth', [credentials.token]);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.debug(
        `ws [${this.server}] token refresh failed (${this.tokenRefreshAttempts}/${this.maxTokenRefreshAttempts}): ${error.message}`,
      );

      this.scheduleTokenRefresh(Math.min(this.minBackoffMs * 2 ** (this.tokenRefreshAttempts - 1), this.maxBackoffMs));
    } finally {
      this.refreshingToken = false;
    }
  }

  private scheduleTokenRefresh(delay: number): void {
    if (this.closed || this.tokenRefreshTimer) {
      return;
    }

    this.tokenRefreshTimer = setTimeout(() => {
      this.tokenRefreshTimer = null;
      void this.refreshToken();
    }, delay);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) {
      return;
    }

    const delay = Math.min(this.minBackoffMs * 2 ** this.reconnectAttempts, this.maxBackoffMs);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.createSocket();
    }, delay);
  }
}
