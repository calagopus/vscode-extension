import * as vscode from 'vscode';
import type { CommandSnippet } from '../api/types.ts';
import { activeConsole, consoleFor } from '../console/pseudoterminal.ts';
import { log } from '../log.ts';
import { type MountedServer, mountedServers } from '../servers.ts';
import type { Session } from '../session.ts';

interface EggScope {
  server: MountedServer;
  eggUuid: string;
  eggName: string;
}

export class SnippetItem extends vscode.TreeItem {
  constructor(
    readonly origin: string,
    readonly snippet: CommandSnippet,
    scopes: EggScope[],
    showScope: boolean,
  ) {
    super(snippet.name, vscode.TreeItemCollapsibleState.None);

    const applicable = scopes.filter((scope) => snippet.eggs.length === 0 || snippet.eggs.includes(scope.eggUuid));
    const scopeLabel =
      snippet.eggs.length === 0 ? 'all eggs' : [...new Set(applicable.map((s) => s.eggName))].join(', ');

    this.description = showScope ? `${snippet.command} — ${scopeLabel}` : snippet.command;
    this.iconPath = new vscode.ThemeIcon('terminal');
    this.tooltip = new vscode.MarkdownString(`**${snippet.name}**\n\n\`${snippet.command}\`\n\n${scopeLabel}`);
    this.contextValue = 'calagopusSnippet';
  }
}

export class SnippetsProvider implements vscode.TreeDataProvider<SnippetItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly session: Session) {}

  dispose(): void {
    this.changeEmitter.dispose();
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  async scopes(): Promise<EggScope[]> {
    const resolved: EggScope[] = [];
    for (const server of mountedServers()) {
      try {
        const client = await this.session.clientIfSignedIn(server.origin);
        if (!client) {
          continue;
        }
        const detail = await client.getServer(server.uuid);
        resolved.push({ server, eggUuid: detail.egg.uuid, eggName: detail.egg.name });
      } catch (err) {
        log.warn(`snippets: could not resolve egg for ${server.uuid}: ${err}`);
      }
    }
    return resolved;
  }

  getTreeItem(item: SnippetItem): vscode.TreeItem {
    return item;
  }

  async getChildren(item?: SnippetItem): Promise<SnippetItem[]> {
    if (item) {
      return [];
    }

    const scopes = await this.scopes();
    if (scopes.length === 0) {
      return [];
    }

    const eggs = new Set(scopes.map((scope) => scope.eggUuid));
    const origins = [...new Set(scopes.map((scope) => scope.server.origin))];
    const showScope = eggs.size > 1;

    const items: SnippetItem[] = [];
    for (const origin of origins) {
      try {
        const client = await this.session.clientIfSignedIn(origin);
        if (!client) {
          continue;
        }
        const snippets = await client.listCommandSnippets();
        for (const snippet of snippets) {
          if (snippet.eggs.length === 0 || snippet.eggs.some((egg) => eggs.has(egg))) {
            items.push(new SnippetItem(origin, snippet, scopes, showScope));
          }
        }
      } catch (err) {
        log.warn(`snippets: could not list for ${origin}: ${err}`);
      }
    }

    return items.sort((a, b) => a.snippet.name.localeCompare(b.snippet.name));
  }
}

export async function runSnippet(
  item: SnippetItem,
  provider: SnippetsProvider,
  openConsoleFor: (server: MountedServer) => vscode.Terminal,
): Promise<void> {
  const scopes = await provider.scopes();
  const candidates = scopes.filter(
    (scope) =>
      scope.server.origin === item.origin &&
      (item.snippet.eggs.length === 0 || item.snippet.eggs.includes(scope.eggUuid)),
  );

  if (candidates.length === 0) {
    vscode.window.showErrorMessage(`Calagopus: "${item.snippet.name}" does not apply to any mounted server.`);
    return;
  }

  const active = activeConsole();
  const activeCandidate = active
    ? candidates.find(
        (scope) => scope.server.origin === active.server.origin && scope.server.uuid === active.server.uuid,
      )
    : undefined;

  let server: MountedServer;
  if (activeCandidate) {
    server = activeCandidate.server;
  } else if (candidates.length === 1) {
    server = candidates[0].server;
  } else {
    const picked = await vscode.window.showQuickPick(
      candidates.map((scope) => ({
        label: scope.server.name,
        description: scope.server.origin,
        server: scope.server,
      })),
      { title: 'Calagopus: select a mounted server', matchOnDescription: true },
    );
    if (!picked) {
      return;
    }
    server = picked.server;
  }

  const handle = consoleFor(server);
  if (handle) {
    handle.pty.runCommand(item.snippet.command);
    handle.terminal.show();
    return;
  }

  openConsoleFor(server);
  vscode.window.showInformationMessage(
    `Calagopus: console opened for ${server.name}. Run the snippet again once it has connected.`,
  );
}

interface ScopePick extends vscode.QuickPickItem {
  origin: string;
  eggs: string[];
}

async function editSnippet(session: Session, provider: SnippetsProvider, existing: SnippetItem | null): Promise<void> {
  const all = await provider.scopes();
  const scopes = existing ? all.filter((scope) => scope.server.origin === existing.origin) : all;
  if (scopes.length === 0) {
    vscode.window.showErrorMessage('Calagopus: mount a server folder before managing snippets.');
    return;
  }

  const name = await vscode.window.showInputBox({
    title: existing ? 'Calagopus: rename snippet' : 'Calagopus: snippet name',
    value: existing?.snippet.name ?? '',
    validateInput: (value) => (value.trim().length === 0 ? 'The snippet needs a name.' : undefined),
  });
  if (!name) {
    return;
  }

  const command = await vscode.window.showInputBox({
    title: 'Calagopus: snippet command',
    value: existing?.snippet.command ?? activeConsole()?.pty.lastCommand ?? '',
    validateInput: (value) => (value.trim().length === 0 ? 'The snippet needs a command.' : undefined),
  });
  if (!command) {
    return;
  }

  const origins = [...new Set(scopes.map((scope) => scope.server.origin))];
  const multiPanel = origins.length > 1;
  const distinct = [...new Map(scopes.map((scope) => [`${scope.server.origin}\0${scope.eggUuid}`, scope])).values()];
  const picks: ScopePick[] = [
    ...origins.map((origin) => ({
      label: 'All eggs',
      description: multiPanel ? origin : 'Available on every server',
      origin,
      eggs: [],
    })),
    ...distinct.map((scope) => ({
      label: scope.eggName,
      description: multiPanel ? `${scope.server.origin} — this egg only` : 'This egg only',
      origin: scope.server.origin,
      eggs: [scope.eggUuid],
    })),
  ];
  const scope = await vscode.window.showQuickPick(picks, { title: 'Calagopus: snippet scope' });
  if (!scope) {
    return;
  }

  try {
    const client = await session.client(scope.origin);
    if (existing) {
      await client.updateCommandSnippet(existing.snippet.uuid, name.trim(), command.trim(), scope.eggs);
    } else {
      await client.createCommandSnippet(name.trim(), command.trim(), scope.eggs);
    }
    provider.refresh();
  } catch (err) {
    log.error(`snippets: save "${name}" failed: ${err}`);
    vscode.window.showErrorMessage(`Calagopus: could not save the snippet: ${err}`);
  }
}

async function deleteSnippet(session: Session, provider: SnippetsProvider, item: SnippetItem): Promise<void> {
  const confirmed = await vscode.window.showWarningMessage(
    `Delete the snippet "${item.snippet.name}"?`,
    { modal: true },
    'Delete',
  );
  if (confirmed !== 'Delete') {
    return;
  }

  try {
    const client = await session.client(item.origin);
    await client.deleteCommandSnippet(item.snippet.uuid);
    provider.refresh();
  } catch (err) {
    log.error(`snippets: delete "${item.snippet.name}" failed: ${err}`);
    vscode.window.showErrorMessage(`Calagopus: could not delete the snippet: ${err}`);
  }
}

async function quickRun(
  provider: SnippetsProvider,
  openConsoleFor: (server: MountedServer) => vscode.Terminal,
): Promise<void> {
  const items = await provider.getChildren();
  if (items.length === 0) {
    vscode.window.showInformationMessage('Calagopus: no command snippets apply to this workspace.');
    return;
  }

  const picked = await vscode.window.showQuickPick(
    items.map((item) => ({ label: item.snippet.name, description: item.snippet.command, item })),
    { title: 'Calagopus: run command snippet', matchOnDescription: true },
  );
  if (picked) {
    await runSnippet(picked.item, provider, openConsoleFor);
  }
}

export function registerSnippetsView(
  session: Session,
  openConsoleFor: (server: MountedServer) => vscode.Terminal,
): vscode.Disposable[] {
  const provider = new SnippetsProvider(session);
  const view = vscode.window.createTreeView('calagopusSnippets', { treeDataProvider: provider });

  return [
    provider,
    view,
    vscode.commands.registerCommand('calagopus.snippets.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('calagopus.snippets.run', (item?: SnippetItem) =>
      item ? runSnippet(item, provider, openConsoleFor) : undefined,
    ),
    vscode.commands.registerCommand('calagopus.snippets.create', () => editSnippet(session, provider, null)),
    vscode.commands.registerCommand('calagopus.snippets.edit', (item?: SnippetItem) =>
      item ? editSnippet(session, provider, item) : undefined,
    ),
    vscode.commands.registerCommand('calagopus.snippets.delete', (item?: SnippetItem) =>
      item ? deleteSnippet(session, provider, item) : undefined,
    ),
    vscode.commands.registerCommand('calagopus.snippets.quickRun', () => quickRun(provider, openConsoleFor)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
  ];
}
