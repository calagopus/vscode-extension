import { ConsoleSocket } from '../console/websocket.ts';
import type { Session } from '../session.ts';

export class WingsSocketHub {
  private readonly entries = new Map<string, Entry>();
  private readonly lingerMs = 30000;

  constructor(private readonly session: Session) {}

  acquire(origin: string, server: string): WingsSocketLease {
    const key = `${origin}\x00${server}`;
    let entry = this.entries.get(key);
    if (!entry) {
      const socket = new ConsoleSocket(this.session, origin, server);
      socket.setMaxListeners(0);
      entry = { socket, refs: 0, authed: false, lingerTimer: null };
      socket.on('auth success', () => {
        if (entry) entry.authed = true;
      });
      socket.on('CONNECTION_STATE', (state: string) => {
        if (state !== 'connected') {
          if (entry) entry.authed = false;
        }
      });
      this.entries.set(key, entry);
    }

    if (entry.lingerTimer) {
      clearTimeout(entry.lingerTimer);
      entry.lingerTimer = null;
    }

    const wasIdle = entry.refs === 0;
    entry.refs++;
    if (wasIdle && !entry.connected) {
      entry.connected = true;
      void entry.socket.connect();
    }

    return new WingsSocketLease(entry, () => this.release(key));
  }

  private release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0 || entry.lingerTimer) {
      return;
    }
    entry.lingerTimer = setTimeout(() => {
      entry.lingerTimer = null;
      if (entry.refs === 0) {
        entry.socket.close();
        this.entries.delete(key);
      }
    }, this.lingerMs);
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.lingerTimer) {
        clearTimeout(entry.lingerTimer);
      }
      entry.socket.close();
    }
    this.entries.clear();
  }
}

interface Entry {
  socket: ConsoleSocket;
  refs: number;
  authed: boolean;
  connected?: boolean;
  lingerTimer: ReturnType<typeof setTimeout> | null;
}

export class WingsSocketLease {
  private readonly listeners: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];
  private released = false;

  constructor(
    private readonly entry: Entry,
    private readonly onRelease: () => void,
  ) {}

  get authenticated(): boolean {
    return this.entry.authed;
  }

  send(event: string, args: string[] = []): void {
    this.entry.socket.send(event, args);
  }

  sendCommand(command: string): void {
    this.entry.socket.sendCommand(command);
  }

  on(event: string, handler: (...args: never[]) => void): void {
    const wrapped = handler as (...args: unknown[]) => void;
    this.entry.socket.on(event, wrapped);
    this.listeners.push({ event, handler: wrapped });
  }

  whenAuthenticated(handler: () => void): void {
    this.on('auth success', handler);
    if (this.entry.authed) {
      queueMicrotask(handler);
    }
  }

  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    for (const { event, handler } of this.listeners) {
      this.entry.socket.off(event, handler);
    }
    this.listeners.length = 0;
    this.onRelease();
  }
}
