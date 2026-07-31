import * as vscode from 'vscode';
import type { PowerAction, PowerState, ResourceUsage } from './api/types.ts';
import { ConsoleSocket } from './console/websocket.ts';
import { formatBytes } from './format.ts';
import { decodeAuthority } from './fs/fileSystemProvider.ts';
import { log } from './log.ts';
import { shortId } from './servers.ts';
import type { Session } from './session.ts';

interface ServerEntry {
  origin: string;
  uuid: string;
  name: string;
  socket: ConsoleSocket;
  state: PowerState | null;
  stats: ResourceUsage | null;
}

interface PowerButton extends vscode.QuickInputButton {
  action: PowerAction;
}

interface ServerPick extends vscode.QuickPickItem {
  origin: string;
  uuid: string;
  name: string;
}

function entryKey(origin: string, uuid: string): string {
  return `${origin}|${uuid.toLowerCase()}`;
}

const POWER_ACTIONS: { action: PowerAction; icon: string; label: string }[] = [
  { action: 'start', icon: 'play', label: 'Start' },
  { action: 'restart', icon: 'debug-restart', label: 'Restart' },
  { action: 'stop', icon: 'debug-stop', label: 'Stop' },
  { action: 'kill', icon: 'close', label: 'Kill' },
];

const POWER_BUTTONS: PowerButton[] = POWER_ACTIONS.map(({ action, icon, label }) => ({
  action,
  iconPath: new vscode.ThemeIcon(icon),
  tooltip: label,
}));

function stateIcon(state: PowerState | null): string {
  switch (state) {
    case 'running':
      return '$(vm-running)';
    case 'offline':
      return '$(vm-outline)';
    case null:
      return '$(server-environment)';
    default:
      return '$(sync~spin)';
  }
}

function formatUptime(ms: number): string {
  if (ms <= 0) return '-';
  let seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (!days && !hours) parts.push(`${seconds}s`);
  return parts.join(' ');
}

export class ServerStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly servers = new Map<string, ServerEntry>();
  private readonly disposables: vscode.Disposable[] = [];
  private pinned: string | null = null;

  constructor(private readonly session: Session) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.item.command = 'calagopus.statusBar.switch';

    this.disposables.push(
      vscode.commands.registerCommand('calagopus.statusBar.switch', () => this.showSwitcher()),
      vscode.window.onDidChangeActiveTextEditor(() => this.render()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.syncServers()),
      this.session.onDidChange(() => this.refreshNames()),
    );

    this.syncServers();
  }

  pin(origin: string, uuid: string, name: string): void {
    if (!uuid) {
      return;
    }
    const key = entryKey(origin, uuid);
    this.pinned = key;
    const existing = this.servers.get(key);
    if (existing) {
      existing.name = name || existing.name;
    } else {
      this.servers.set(key, this.createEntry(origin, uuid, name));
    }
    this.render();
  }

  private syncServers(): void {
    const wanted = new Map<string, { origin: string; uuid: string }>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme === 'calagopus') {
        const { origin, server } = decodeAuthority(folder.uri.authority);
        wanted.set(entryKey(origin, server), { origin, uuid: server });
      }
    }

    for (const [key, entry] of this.servers) {
      if (!wanted.has(key) && key !== this.pinned) {
        entry.socket.close();
        this.servers.delete(key);
      }
    }

    for (const [key, server] of wanted) {
      if (!this.servers.has(key)) {
        this.servers.set(key, this.createEntry(server.origin, server.uuid, ''));
      }
    }

    this.render();
  }

  private createEntry(origin: string, uuid: string, name: string): ServerEntry {
    const socket = new ConsoleSocket(this.session, origin, uuid);
    const entry: ServerEntry = { origin, uuid, name, socket, state: null, stats: null };
    const key = entryKey(origin, uuid);

    socket.on('auth success', () => {
      socket.send('send stats');
      socket.send('send status');
    });
    socket.on('status', (state: PowerState) => {
      entry.state = state;
      this.renderIfFocused(key);
    });
    socket.on('stats', (raw: string) => {
      try {
        const stats = JSON.parse(raw) as ResourceUsage;
        entry.stats = stats;
        entry.state = stats.state;
        this.renderIfFocused(key);
      } catch {
        // ignore malformed stats frames
      }
    });
    socket.on('CONNECTION_ERROR', (err: Error) => log.debug(`statusbar ws [${uuid}]: ${err.message}`));

    void socket.connect();
    void this.resolveName(entry);
    return entry;
  }

  private async resolveName(entry: ServerEntry): Promise<void> {
    try {
      const client = await this.session.clientIfSignedIn(entry.origin);
      if (!client) {
        return;
      }
      const { name } = await client.getServer(entry.uuid);
      if (name && name !== entry.name) {
        entry.name = name;
        this.render();
      }
    } catch (err) {
      log.debug(`statusbar: could not resolve name for ${entry.uuid}: ${err}`);
    }
  }

  private refreshNames(): void {
    for (const entry of this.servers.values()) {
      void this.resolveName(entry);
    }
  }

  private displayName(entry: ServerEntry): string {
    return entry.name || shortId(entry.uuid);
  }

  private focusedKey(): string | null {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === 'calagopus') {
      const { origin, server } = decodeAuthority(uri.authority);
      const key = entryKey(origin, server);
      if (this.servers.has(key)) {
        return key;
      }
    }
    if (this.pinned && this.servers.has(this.pinned)) {
      return this.pinned;
    }
    const first = this.servers.keys().next();
    return first.done ? null : first.value;
  }

  private renderIfFocused(key: string): void {
    if (this.focusedKey() === key) {
      this.render();
    }
  }

  private render(): void {
    const key = this.focusedKey();
    if (!key) {
      this.item.hide();
      return;
    }

    const entry = this.servers.get(key);
    if (!entry) {
      this.item.hide();
      return;
    }

    this.item.text = `${stateIcon(entry.state)} ${this.displayName(entry)}${entry.state ? ` (${entry.state})` : ''}`;
    this.item.tooltip = this.tooltip(entry);
    this.item.show();
  }

  private tooltip(entry: ServerEntry): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${this.displayName(entry)}** - ${entry.state ?? 'unknown'}\n\n`);

    const stats = entry.stats;
    if (stats) {
      const memLimit = stats.memory_limit_bytes > 0 ? ` / ${formatBytes(stats.memory_limit_bytes)}` : '';
      md.appendMarkdown('|  |  |\n|---|---|\n');
      md.appendMarkdown(`| $(dashboard) CPU | ${stats.cpu_absolute.toFixed(1)}% |\n`);
      md.appendMarkdown(`| $(server) Memory | ${formatBytes(stats.memory_bytes)}${memLimit} |\n`);
      md.appendMarkdown(`| $(database) Disk | ${formatBytes(stats.disk_bytes)} |\n`);
      md.appendMarkdown(
        `| $(arrow-down)$(arrow-up) Network | ${formatBytes(stats.network.rx_bytes)} / ${formatBytes(stats.network.tx_bytes)} |\n`,
      );
      md.appendMarkdown(`| $(watch) Uptime | ${formatUptime(stats.uptime)} |\n`);
    } else {
      md.appendMarkdown('_Waiting for live stats..._\n');
    }

    md.appendMarkdown('\n$(list-selection) Click to switch servers or run power actions.');
    return md;
  }

  private statsLine(entry: ServerEntry): string {
    const stats = entry.stats;
    if (!stats) {
      return 'no live stats yet';
    }
    return `CPU ${stats.cpu_absolute.toFixed(1)}%  •  Mem ${formatBytes(stats.memory_bytes)}  •  Disk ${formatBytes(stats.disk_bytes)}  •  up ${formatUptime(stats.uptime)}`;
  }

  private showSwitcher(): void {
    if (this.servers.size === 0) {
      vscode.window.showInformationMessage('Calagopus: no active server.');
      return;
    }

    const focused = this.focusedKey();
    const qp = vscode.window.createQuickPick<ServerPick>();
    qp.title = 'Calagopus servers';
    qp.placeholder = 'Select a server to focus - use the buttons for power actions';
    qp.items = [...this.servers.values()].map((entry) => ({
      label: `${stateIcon(entry.state)} ${this.displayName(entry)}`,
      description: entry.state ?? 'unknown',
      detail: this.statsLine(entry),
      buttons: POWER_BUTTONS,
      origin: entry.origin,
      uuid: entry.uuid,
      name: this.displayName(entry),
    }));
    qp.activeItems = qp.items.filter((i) => entryKey(i.origin, i.uuid) === focused);

    qp.onDidTriggerItemButton((event) => {
      void this.powerAction(event.item.origin, event.item.uuid, event.item.name, (event.button as PowerButton).action);
    });
    qp.onDidAccept(() => {
      const pick = qp.selectedItems[0];
      if (pick) {
        this.pin(pick.origin, pick.uuid, pick.name);
      }
      qp.hide();
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  async showPowerActions(): Promise<void> {
    const key = this.focusedKey();
    const entry = key ? this.servers.get(key) : null;
    if (!entry) {
      vscode.window.showInformationMessage('Calagopus: no active server.');
      return;
    }

    const picked = await vscode.window.showQuickPick(
      POWER_ACTIONS.map(({ action, icon, label }) => ({ label: `$(${icon}) ${label}`, action })),
      { title: `Power action for ${this.displayName(entry)}` },
    );
    if (picked) {
      await this.powerAction(entry.origin, entry.uuid, this.displayName(entry), picked.action);
    }
  }

  private async powerAction(origin: string, uuid: string, name: string, action: PowerAction): Promise<void> {
    if (action === 'kill') {
      const confirmed = await vscode.window.showWarningMessage(
        `Kill ${name}? This may cause data loss.`,
        { modal: true },
        'Kill',
      );
      if (confirmed !== 'Kill') {
        return;
      }
    }

    try {
      const client = await this.session.client(origin);
      await client.sendPowerAction(uuid, action);
    } catch (err) {
      vscode.window.showErrorMessage(`Calagopus: power action failed (${err}).`);
    }
  }

  dispose(): void {
    for (const entry of this.servers.values()) {
      entry.socket.close();
    }
    this.servers.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.item.dispose();
  }
}
