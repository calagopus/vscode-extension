import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as vscode from 'vscode';
import { callbackPage } from './authPage.ts';
import { log } from './log.ts';

const CREATE_KEY_PATH = '/account/api-keys/create';
const UPDATE_KEY_PATH = '/account/api-keys/update';

const CREATE_KEY_NAME = 'VS Code';
const CREATE_KEY_ADMIN_PERMISSIONS = ['servers.read'];
const CREATE_KEY_USER_PERMISSIONS = [
  'servers.read',
  'command-snippets.read',
  'command-snippets.create',
  'command-snippets.update',
  'command-snippets.delete',
];
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
  'files.delete',
  'files.archive',
  'backups.read',
];

function applyPermissionParams(target: URL): void {
  target.searchParams.set('admin_permissions', CREATE_KEY_ADMIN_PERMISSIONS.join(','));
  target.searchParams.set('user_permissions', CREATE_KEY_USER_PERMISSIONS.join(','));
  target.searchParams.set('server_permissions', CREATE_KEY_SERVER_PERMISSIONS.join(','));
}

async function openWithCallback(target: URL, callback: { url: string; state: string }): Promise<void> {
  const external = await vscode.env.asExternalUri(vscode.Uri.parse(callback.url));
  const callbackUrl = new URL(external.toString(true));
  callbackUrl.searchParams.set('state', callback.state);
  target.searchParams.set('callback_url', callbackUrl.toString());

  await vscode.env.openExternal(target.toString() as unknown as vscode.Uri);
}

export async function provisionApiKey(origin: string): Promise<string | null> {
  const callback = await startCallbackServer({
    requireKey: true,
    okPage: callbackPage({
      tone: 'success',
      heading: 'Signed in',
      message: 'Your new API key was handed back to your editor.',
      autoClose: true,
    }),
  });

  try {
    const target = new URL(CREATE_KEY_PATH, origin);
    target.searchParams.set('name', CREATE_KEY_NAME);
    applyPermissionParams(target);

    log.info(`auth: redirecting to ${target.origin}${target.pathname} to create an API key`);
    await openWithCallback(target, callback);

    return await awaitKey(origin, callback.result);
  } finally {
    callback.dispose();
  }
}

export async function requestApiKeyPermissions(origin: string, keyStart: string): Promise<boolean> {
  const callback = await startCallbackServer({
    requireKey: false,
    okPage: callbackPage({
      tone: 'success',
      heading: 'Permissions updated',
      message: `The permissions of ${keyStart} were updated for your editor.`,
      autoClose: true,
    }),
  });

  try {
    const target = new URL(UPDATE_KEY_PATH, origin);
    target.searchParams.set('key_start', keyStart);
    applyPermissionParams(target);

    log.info(`auth: redirecting to ${target.origin}${target.pathname} to update the permissions of ${keyStart}`);
    await openWithCallback(target, callback);

    return await awaitUpdate(origin, callback.result);
  } finally {
    callback.dispose();
  }
}

async function awaitUpdate(origin: string, fromCallback: Promise<string | null>): Promise<boolean> {
  return vscode.window.withProgress<boolean>(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Calagopus: waiting for the permission update to be approved on ${origin}…`,
      cancellable: true,
    },
    (_progress, token) =>
      Promise.race([
        fromCallback.then((value) => value !== null),
        new Promise<boolean>((resolve) => token.onCancellationRequested(() => resolve(false))),
      ]),
  );
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

function startCallbackServer(options: {
  requireKey: boolean;
  okPage: string;
}): Promise<{ url: string; state: string; result: Promise<string | null>; dispose: () => void }> {
  return new Promise((resolve, reject) => {
    let deliver!: (value: string | null) => void;
    const result = new Promise<string | null>((res) => {
      deliver = res;
    });

    const state = crypto.randomUUID();
    const server = http.createServer((req, res) => {
      const requested = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (requested.pathname !== '/' || requested.searchParams.get('state') !== state) {
        res.writeHead(404).end();
        return;
      }

      const received = requested.searchParams.get('key');
      const ok = options.requireKey ? !!received : true;
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        ok
          ? options.okPage
          : callbackPage({
              tone: 'error',
              heading: 'No API key received',
              message: 'The panel did not hand back a key. Return to your editor and try again.',
            }),
      );

      if (ok) {
        deliver(received ?? '');
      }
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        state,
        result,
        dispose: () => {
          deliver(null);
          server.close();
        },
      });
    });
  });
}
