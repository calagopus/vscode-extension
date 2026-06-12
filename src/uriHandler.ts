import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as vscode from 'vscode';
import type { PanelClient } from './api/client.ts';
import { serverUri } from './fs/fileSystemProvider.ts';
import { log } from './log.ts';
import { type MountedServer, mountWillReload, openServerFolder, shortId } from './servers.ts';
import type { Session } from './session.ts';

export const PENDING_CONSOLE_KEY = 'calagopus.pendingConsole';
export const PENDING_EXPLORER_KEY = 'calagopus.pendingExplorer';
export const PENDING_FILE_KEY = 'calagopus.pendingFile';

const CREATE_KEY_NAME = 'VS Code';
const CREATE_KEY_ADMIN_PERMISSIONS = ['servers.read'];
const CREATE_KEY_USER_PERMISSIONS = ['servers.read'];
const CREATE_KEY_SERVER_PERMISSIONS = [
  'control.read-console',
  'control.console',
  'control.start',
  'control.stop',
  'control.restart',
  'files.create',
  'files.read',
  'files.read-content',
  'files.update',
  'files.write',
  'files.delete',
  'files.archive',
];

function callbackPage(message: string, autoClose = false): string {
  const script = autoClose ? '<script>setTimeout(() => window.close(), 3000);</script>' : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Calagopus</title></head><body style="font-family: system-ui, sans-serif; text-align: center; padding: 4rem;"><h2>Calagopus</h2><p>${message}</p>${script}</body></html>`;
}

const CALLBACK_OK_PAGE = callbackPage('Signed in. This tab will close automatically.', true);
const CALLBACK_BAD_PAGE = callbackPage('No API key was provided. Please return to your editor and try again.');

function isTruthy(value: string | null): boolean {
  return value !== null && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

function normalizeFilePath(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export async function openFile(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.commands.executeCommand('vscode.open', uri);
  } catch (err) {
    log.warn(`uri handler: could not open file ${uri.toString()}: ${err}`);
  }
}

export class CalagopusUriHandler implements vscode.UriHandler {
  constructor(
    private readonly session: Session,
    private readonly globalState: vscode.Memento,
    private readonly openConsole: (server: MountedServer) => void,
  ) {}

  async handleUri(uri: vscode.Uri): Promise<void> {
    if (uri.path !== '/open') {
      return;
    }
    await this.handleOpen(uri, new URLSearchParams(uri.query));
  }

  private async handleOpen(uri: vscode.Uri, params: URLSearchParams): Promise<void> {
    const origin = params.get('origin');
    const server = params.get('server');
    const apiKey = params.get('apiKey');
    const createPath = params.get('create_path');
    const wantConsole = isTruthy(params.get('console'));
    const fileParam = params.get('file');

    if (!origin || !server) {
      log.error(`uri handler: malformed open link: ${uri.toString()}`);
      vscode.window.showErrorMessage('Calagopus: malformed open link.');
      return;
    }

    log.info(
      `uri handler: open server ${server} from ${origin}${apiKey ? ' (key supplied)' : ''}${
        wantConsole ? ' (+console)' : ''
      }${fileParam ? ` (+file ${fileParam})` : ''}`,
    );

    const client = apiKey
      ? await this.session.ephemeralClient(origin, apiKey)
      : ((await this.session.clientIfSignedIn(origin)) ??
        (createPath
          ? await this.redirectToCreateKey(origin, createPath, params)
          : await this.session.promptSignIn(origin)));
    if (!client) {
      return;
    }

    await this.openServer(client, params);
  }

  private async openServer(client: PanelClient, params: URLSearchParams): Promise<void> {
    const server = params.get('server');
    if (!server) {
      return;
    }
    const wantConsole = isTruthy(params.get('console'));
    const fileParam = params.get('file');

    let name = shortId(server);
    try {
      name = (await client.getServer(server)).name || name;
    } catch (err) {
      log.warn(`uri handler: could not fetch name for server ${server}: ${err}`);
    }

    const target: MountedServer = { origin: client.origin, uuid: server, name };
    const fileUri = fileParam ? serverUri(target.origin, target.uuid, normalizeFilePath(fileParam)) : undefined;

    const willReload = mountWillReload(target);
    if (wantConsole) {
      await this.globalState.update(PENDING_CONSOLE_KEY, target);
    }
    if (fileUri) {
      await this.globalState.update(PENDING_FILE_KEY, fileUri.toString());
    }
    if (willReload) {
      await this.globalState.update(PENDING_EXPLORER_KEY, true);
    }

    await openServerFolder(target);

    if (willReload) {
      return;
    }

    await vscode.commands.executeCommand('workbench.view.explorer');
    if (fileUri) {
      await this.globalState.update(PENDING_FILE_KEY, undefined);
      await openFile(fileUri);
    }
    if (wantConsole) {
      await this.globalState.update(PENDING_CONSOLE_KEY, undefined);
      this.openConsole(target);
    }
  }

  private async redirectToCreateKey(
    origin: string,
    createPath: string,
    _params: URLSearchParams,
  ): Promise<PanelClient | null> {
    // A loopback HTTP server gives us a plain http(s) callback that works across editors
    // (VSCodium and other forks don't reliably register a custom URI scheme). asExternalUri
    // forwards the port when running in Remote/Codespaces; on plain desktop it is a no-op.
    const callback = await this.startCallbackServer();
    try {
      const external = await vscode.env.asExternalUri(vscode.Uri.parse(callback.url));

      const target = new URL(normalizeFilePath(createPath), origin);
      target.searchParams.set('name', CREATE_KEY_NAME);
      target.searchParams.set('admin_permissions', CREATE_KEY_ADMIN_PERMISSIONS.join(','));
      target.searchParams.set('user_permissions', CREATE_KEY_USER_PERMISSIONS.join(','));
      target.searchParams.set('server_permissions', CREATE_KEY_SERVER_PERMISSIONS.join(','));
      target.searchParams.set('callback_url', external.toString());

      log.info(`uri handler: redirecting to ${target.origin}${target.pathname} to create an API key`);
      await vscode.env.openExternal(vscode.Uri.parse(target.toString()));

      const key = await this.awaitKey(origin, callback.key);
      if (!key) {
        log.info(`uri handler: authentication for ${origin} was cancelled or timed out`);
        return null;
      }
      return await this.session.signInWithKey(origin, key);
    } finally {
      callback.dispose();
    }
  }

  // Show a progress indicator while the browser round-trip happens, with a password input as a
  // manual fallback in case the callback never arrives. Resolves to the first key we obtain.
  private async awaitKey(origin: string, fromCallback: Promise<string | null>): Promise<string | null> {
    const tokenSource = new vscode.CancellationTokenSource();
    void fromCallback.then((key) => {
      if (key) {
        tokenSource.cancel(); // dismiss the manual prompt once the callback lands
      }
    });

    const manual = vscode.window.withProgress<string | undefined>(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Calagopus: waiting for authentication from ${origin}…`,
        cancellable: true,
      },
      (_progress, progressToken) => {
        progressToken.onCancellationRequested(() => tokenSource.cancel());
        return Promise.resolve(
          vscode.window.showInputBox(
            {
              title: 'Calagopus: finish signing in',
              prompt: 'Approve in your browser to finish automatically, or paste an API key here.',
              password: true,
              ignoreFocusOut: true,
            },
            tokenSource.token,
          ),
        );
      },
    );

    const key = await Promise.race([fromCallback, manual.then((value) => value ?? null)]);
    tokenSource.dispose();
    const trimmed = key?.trim();
    return trimmed ? trimmed : null;
  }

  private startCallbackServer(): Promise<{ url: string; key: Promise<string | null>; dispose: () => void }> {
    return new Promise((resolve, reject) => {
      let deliverKey!: (key: string | null) => void;
      const key = new Promise<string | null>((res) => {
        deliverKey = res;
      });

      const server = http.createServer((req, res) => {
        const received = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('key');
        res.writeHead(received ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(received ? CALLBACK_OK_PAGE : CALLBACK_BAD_PAGE);
        if (received) {
          deliverKey(received);
        }
      });

      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${port}/`,
          key,
          dispose: () => {
            deliverKey(null);
            server.close();
          },
        });
      });
    });
  }
}
