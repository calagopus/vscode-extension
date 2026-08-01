import * as vscode from 'vscode';
import { CollabManager } from './collab/collabManager.ts';
import { ConsolePseudoterminal, createConsoleTerminal, trackConsoleTerminals } from './console/pseudoterminal.ts';
import { registerFileActions } from './files/actions.ts';
import { FileOperationTracker } from './files/operations.ts';
import { CalagopusFileSystem } from './fs/fileSystemProvider.ts';
import { log } from './log.ts';
import { registerRevisionsView } from './revisions/revisionsView.ts';
import { CalagopusFileSearchProvider, CalagopusTextSearchProvider } from './search/searchProvider.ts';
import {
  type MountedServer,
  mountedServers,
  openServerFolder,
  pickMountedServer,
  pickServer,
  workspaceServers,
} from './servers.ts';
import { Session } from './session.ts';
import { SettingsCache } from './settings.ts';
import { registerSnippetsView } from './snippets/snippetsView.ts';
import { ServerStatusBar } from './statusBar.ts';
import {
  CalagopusUriHandler,
  openFile,
  PENDING_CONSOLE_KEY,
  PENDING_EXPLORER_KEY,
  PENDING_FILE_KEY,
} from './uriHandler.ts';
import { WingsSocketHub } from './wings/socketHub.ts';

export function activate(context: vscode.ExtensionContext): void {
  log.info(
    `activating (workspace folders: ${
      (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.toString()).join(', ') || 'none'
    })`,
  );

  const session = new Session(context.secrets);
  const settings = new SettingsCache(session);
  const statusBar = new ServerStatusBar(session);
  const socketHub = new WingsSocketHub(session);
  const collab = new CollabManager(socketHub, session);
  const fs = new CalagopusFileSystem(session, settings, collab);
  const operations = new FileOperationTracker(socketHub, session, fs);
  fs.setOperationTracker(operations);

  const openConsoleFor = (server: MountedServer): vscode.Terminal => {
    const { terminal } = createConsoleTerminal(socketHub, settings, server.origin, server.uuid, server.name);
    statusBar.pin(server.origin, server.uuid, server.name);
    terminal.show();
    return terminal;
  };

  const openConsole = async () => {
    const server = await pickMountedServer(session);
    if (!server) {
      return null;
    }
    return openConsoleFor(server);
  };

  context.subscriptions.push(
    log,
    statusBar,
    collab,
    operations,
    { dispose: () => socketHub.dispose() },

    vscode.workspace.registerFileSystemProvider('calagopus', fs, {
      isCaseSensitive: true,
    }),

    vscode.window.registerUriHandler(new CalagopusUriHandler(session, context.globalState, openConsoleFor)),

    ...registerRevisionsView(session),
    ...registerSnippetsView(session, openConsoleFor),
    ...registerFileActions(session, operations, fs),
    ...trackConsoleTerminals(),
  );

  const updateMountedContext = () =>
    vscode.commands.executeCommand('setContext', 'calagopus.workspaceMounted', workspaceServers().length > 0);
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      updateMountedContext();
      void operations.sync();
    }),
  );
  void updateMountedContext();

  try {
    context.subscriptions.push(
      vscode.workspace.registerTextSearchProvider2('calagopus', new CalagopusTextSearchProvider(session)),
      vscode.workspace.registerFileSearchProvider2('calagopus', new CalagopusFileSearchProvider(session)),
    );
    log.info('search providers registered (proposed API available)');
  } catch (err) {
    log.warn(`search providers unavailable (proposed API not enabled): ${err}`);
  }

  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider('calagopus.console', {
      async provideTerminalProfile() {
        const server = await pickMountedServer(session);
        if (!server) {
          throw new Error('No server selected.');
        }

        const pty = new ConsolePseudoterminal(socketHub, settings, server.origin, server.uuid, server.name);
        statusBar.pin(server.origin, server.uuid, server.name);

        return new vscode.TerminalProfile({
          name: `Console: ${server.name}`,
          pty,
          iconPath: new vscode.ThemeIcon('server-environment'),
        });
      },
    }),

    vscode.commands.registerCommand('calagopus.signIn', () => session.promptSignIn()),

    vscode.commands.registerCommand('calagopus.signOut', async () => {
      const origins = await session.origins();
      if (origins.length === 0) {
        vscode.window.showInformationMessage('Calagopus: not signed in.');
        return;
      }

      const ALL = 'All panels';
      const picked =
        origins.length === 1
          ? origins[0]
          : await vscode.window.showQuickPick([...origins, ALL], {
              title: 'Calagopus: sign out of which panel?',
            });
      if (!picked) {
        return;
      }

      await session.signOut(picked === ALL ? undefined : picked);
      vscode.window.showInformationMessage(
        picked === ALL ? 'Calagopus: signed out of all panels.' : `Calagopus: signed out of ${picked}.`,
      );
    }),

    vscode.commands.registerCommand('calagopus.updatePermissions', async () => {
      const origins = await session.origins();
      if (origins.length === 0) {
        vscode.window.showInformationMessage('Calagopus: not signed in.');
        return;
      }

      const picked =
        origins.length === 1
          ? origins[0]
          : await vscode.window.showQuickPick(origins, {
              title: 'Calagopus: update the API key of which panel?',
            });
      if (!picked) {
        return;
      }

      if (await session.updateApiKeyPermissions(picked)) {
        vscode.window.showInformationMessage(`Calagopus: API key permissions updated for ${picked}.`);
      } else {
        vscode.window.showWarningMessage(`Calagopus: the API key permissions for ${picked} were not updated.`);
      }
    }),

    vscode.commands.registerCommand('calagopus.openServer', async () => {
      const picked = await pickServer(session);
      if (picked) {
        const server = { origin: picked.origin, uuid: picked.server.uuid, name: picked.server.name };
        statusBar.pin(server.origin, server.uuid, server.name);
        await openServerFolder(server);
      }
    }),

    vscode.commands.registerCommand('calagopus.openConsole', () => openConsole()),
    vscode.commands.registerCommand('calagopus.powerAction', () => statusBar.showPowerActions()),

    vscode.commands.registerCommand('calagopus.enableCollab', () => setCollabEnabled(true)),
    vscode.commands.registerCommand('calagopus.disableCollab', () => setCollabEnabled(false)),
    vscode.commands.registerCommand('calagopus.revertToDisk', (uri?: vscode.Uri) => collab.revertToDisk(uri)),
  );

  const restored = workspaceServers()[0];
  if (restored) {
    log.info(`restored calagopus workspace for server ${restored.server} on ${restored.origin}`);
  }

  void (async () => {
    await resumePendingExplorer(context);
    await resumePendingFile(context);
    await resumePendingConsole(context, openConsoleFor);
  })();

  log.info('activated');
}

async function setCollabEnabled(enabled: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration()
    .update('calagopus.collaboration.enabled', enabled, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Calagopus: collaboration ${enabled ? 'enabled' : 'disabled'}.`);
}

async function resumePendingExplorer(context: vscode.ExtensionContext): Promise<void> {
  if (!context.globalState.get<boolean>(PENDING_EXPLORER_KEY)) {
    return;
  }
  await context.globalState.update(PENDING_EXPLORER_KEY, undefined);
  log.info('revealing explorer for freshly opened workspace');
  await vscode.commands.executeCommand('workbench.view.explorer');
}

async function resumePendingFile(context: vscode.ExtensionContext): Promise<void> {
  const stored = context.globalState.get<string>(PENDING_FILE_KEY);
  if (!stored) {
    return;
  }
  await context.globalState.update(PENDING_FILE_KEY, undefined);

  const uri = vscode.Uri.parse(stored);
  const mounted = (vscode.workspace.workspaceFolders ?? []).some(
    (folder) => folder.uri.scheme === 'calagopus' && folder.uri.authority === uri.authority,
  );
  if (!mounted) {
    log.warn(`pending file ${stored}: owning server is not mounted; skipping`);
    return;
  }

  log.info(`opening pending file ${stored}`);
  await openFile(uri);
}

async function resumePendingConsole(
  context: vscode.ExtensionContext,
  openConsoleFor: (server: MountedServer) => void,
): Promise<void> {
  const pending = context.globalState.get<MountedServer>(PENDING_CONSOLE_KEY);
  if (!pending) {
    return;
  }

  const isMounted = mountedServers().some(
    (s) => s.origin === pending.origin && s.uuid.toLowerCase() === pending.uuid.toLowerCase(),
  );
  if (!isMounted) {
    return;
  }

  await context.globalState.update(PENDING_CONSOLE_KEY, undefined);
  log.info(`resuming console for ${pending.uuid} on ${pending.origin}`);
  openConsoleFor(pending);
}

export function deactivate(): void {
  log.info('deactivated');
}
