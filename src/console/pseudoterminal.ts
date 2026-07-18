import * as vscode from 'vscode';
import type { PowerState } from '../api/types.ts';
import { log } from '../log.ts';
import type { SettingsCache } from '../settings.ts';
import type { WingsSocketHub, WingsSocketLease } from '../wings/socketHub.ts';

const DEFAULT_PRELUDE = 'container@calagopus~';

const STATE_LABELS: Record<string, string> = {
  unknown: 'Unknown',
  offline: 'Offline',
  running: 'Running',
  starting: 'Starting',
  stopping: 'Stopping',
};

export class ConsolePseudoterminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;

  private readonly closeEmitter = new vscode.EventEmitter<number | undefined>();
  readonly onDidClose = this.closeEmitter.event;

  private readonly statusEmitter = new vscode.EventEmitter<PowerState>();
  readonly onDidChangeStatus = this.statusEmitter.event;

  private socket: WingsSocketLease | null = null;
  private prelude = DEFAULT_PRELUDE;
  private input = '';
  private history: string[] = [];
  private historyIndex = -1;

  constructor(
    private readonly hub: WingsSocketHub,
    private readonly settings: SettingsCache,
    private readonly origin: string,
    private readonly server: string,
    private readonly serverName: string,
  ) {}

  open(): void {
    void this.settings.tryGet(this.origin).then((settings) => {
      if (settings) {
        this.prelude = settings.server.container_prelude;
      }
    });

    this.addLine(`Connecting to ${this.serverName}...`, true);

    const socket = this.hub.acquire(this.origin, this.server);
    this.socket = socket;

    socket.whenAuthenticated(() => {
      socket.send('send logs');
      socket.send('send status');
    });

    socket.on('console output', (line: string) => this.addLine(line));
    socket.on('install output', (line: string) => this.addLine(line));
    socket.on('transfer logs', (line: string) => this.addLine(line));

    socket.on('status', (status: PowerState) => {
      this.addLine(`Server marked as ${STATE_LABELS[status] ?? status}...`, true);
      this.statusEmitter.fire(status);
    });

    socket.on('install completed', (success: string) => {
      this.addLine(success === 'false' ? 'Installation has failed.' : 'Installation has completed successfully.', true);
    });

    socket.on('transfer status', (status: string) => {
      if (status === 'failure') {
        this.addLine('Transfer has failed.', true);
      } else if (status === 'completed') {
        this.addLine('Transfer has completed successfully. Reconnecting to server...', true);
      }
    });

    socket.on('daemon message', (message: string) => this.addLine(message, true));
    socket.on('daemon error', (message: string) => this.addLine(`\x1b[1m\x1b[41m${message}\x1b[0m`, true));

    socket.on('CONNECTION_STATE', (state: string) => {
      if (state === 'reconnecting') {
        this.addLine('Connection lost, reconnecting...', true);
      }
    });
    socket.on('CONNECTION_ERROR', (err: Error) => {
      log.error(`console [${this.serverName}]: ${err.message}`);
      this.addLine(`\x1b[1m\x1b[41m${err.message}\x1b[0m`, true);
    });
  }

  close(): void {
    this.socket?.release();
    this.socket = null;
    this.statusEmitter.dispose();
  }

  private addLine(text: string, prelude = false): void {
    let processed = text.replaceAll('\x1b[?25h', '').replaceAll('\x1b[?25l', '');

    if (processed.includes('container@pterodactyl~')) {
      processed = processed.replace('container@pterodactyl~', this.prelude);
    }

    if (prelude && !processed.includes('\x1b[1m\x1b[41m')) {
      processed = `\x1b[1m\x1b[33m${this.prelude} \x1b[0m${processed}`;
    }

    this.println(processed);
  }

  handleInput(data: string): void {
    switch (data) {
      case '\r': {
        this.writeEmitter.fire('\r\x1b[K');
        const command = this.input;
        this.input = '';
        this.historyIndex = -1;
        if (command.trim().length > 0) {
          this.history.push(command);
          this.socket?.sendCommand(command);
        }
        return;
      }
      case '\x7f': // backspace
        if (this.input.length > 0) {
          this.input = this.input.slice(0, -1);
          this.writeEmitter.fire('\b \b');
        }
        return;
      case '\x03': // ctrl+c
        this.input = '';
        this.historyIndex = -1;
        this.writeEmitter.fire('^C\r\n');
        return;
      case '\x1b[A': // up
        this.recallHistory(-1);
        return;
      case '\x1b[B': // down
        this.recallHistory(1);
        return;
    }

    if (data.startsWith('\x1b')) {
      return;
    }

    const printable = data.replace(/[\r\n]+/g, ' ');
    this.input += printable;
    this.writeEmitter.fire(printable);
  }

  private recallHistory(direction: -1 | 1): void {
    if (this.history.length === 0) {
      return;
    }

    if (this.historyIndex === -1) {
      if (direction === 1) {
        return;
      }
      this.historyIndex = this.history.length;
    }

    const next = this.historyIndex + direction;
    if (next < 0 || next > this.history.length) {
      return;
    }

    this.writeEmitter.fire(`\r\x1b[K`);
    this.historyIndex = next;
    this.input = next === this.history.length ? '' : this.history[next];
    this.writeEmitter.fire(this.input);
  }

  private println(line: string): void {
    this.writeEmitter.fire(`\r\x1b[K${line}\r\n`);
    if (this.input.length > 0) {
      this.writeEmitter.fire(this.input);
    }
  }
}

export function createConsoleTerminal(
  hub: WingsSocketHub,
  settings: SettingsCache,
  origin: string,
  server: string,
  serverName: string,
): { terminal: vscode.Terminal; pty: ConsolePseudoterminal } {
  const pty = new ConsolePseudoterminal(hub, settings, origin, server, serverName);
  const terminal = vscode.window.createTerminal({
    name: `Console: ${serverName}`,
    pty,
    iconPath: new vscode.ThemeIcon('server-environment'),
  });
  return { terminal, pty };
}
