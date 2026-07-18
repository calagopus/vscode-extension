import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as vscode from 'vscode';
import { log } from './log.ts';

const CREATE_KEY_PATH = '/account/api-keys/create';

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

export async function provisionApiKey(origin: string): Promise<string | null> {
  const callback = await startCallbackServer();
  try {
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(callback.url));

    const target = new URL(CREATE_KEY_PATH, origin);
    target.searchParams.set('name', CREATE_KEY_NAME);
    target.searchParams.set('admin_permissions', CREATE_KEY_ADMIN_PERMISSIONS.join(','));
    target.searchParams.set('user_permissions', CREATE_KEY_USER_PERMISSIONS.join(','));
    target.searchParams.set('server_permissions', CREATE_KEY_SERVER_PERMISSIONS.join(','));
    target.searchParams.set('callback_url', external.toString());

    log.info(`auth: redirecting to ${target.origin}${target.pathname} to create an API key`);
    await vscode.env.openExternal(vscode.Uri.parse(target.toString()));

    return await awaitKey(origin, callback.key);
  } finally {
    callback.dispose();
  }
}

async function awaitKey(origin: string, fromCallback: Promise<string | null>): Promise<string | null> {
  const tokenSource = new vscode.CancellationTokenSource();
  void fromCallback.then((key) => {
    if (key) {
      tokenSource.cancel();
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

function startCallbackServer(): Promise<{ url: string; key: Promise<string | null>; dispose: () => void }> {
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
