import * as vscode from 'vscode';
import { ApiError, PanelClient } from './api/client.ts';
import { log } from './log.ts';

const ORIGINS_KEY = 'calagopus.origins';
const API_KEY_PREFIX = 'calagopus.apiKey:';

export class Session {
  private readonly clients = new Map<string, PanelClient>();
  private readonly ephemeral = new Set<string>();
  private readonly reauthing = new Map<string, Promise<boolean>>();
  private reauthQueue: Promise<void> = Promise.resolve();

  private readonly didChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.didChangeEmitter.event;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  async origins(): Promise<string[]> {
    const raw = await this.secrets.get(ORIGINS_KEY);
    if (!raw) {
      return [];
    }
    try {
      const list = JSON.parse(raw) as unknown;
      return Array.isArray(list) ? (list as string[]) : [];
    } catch {
      return [];
    }
  }

  async client(origin?: string): Promise<PanelClient> {
    const target = await this.resolveOrigin(origin);

    if (target) {
      const existing = await this.tryClient(target);
      if (existing) {
        return existing;
      }
    }

    const client = await this.promptSignIn(target);
    if (!client) {
      throw new Error('Not signed in to a Calagopus panel.');
    }
    return client;
  }

  async clientIfSignedIn(origin?: string): Promise<PanelClient | null> {
    const target = await this.resolveOrigin(origin);
    return target ? this.tryClient(target) : null;
  }

  private async resolveOrigin(origin?: string): Promise<string | null> {
    if (origin) {
      return new URL(origin).origin;
    }
    return (await this.origins())[0] ?? null;
  }

  private async tryClient(origin: string): Promise<PanelClient | null> {
    const cached = this.clients.get(origin);
    if (cached) {
      return cached;
    }

    const apiKey = await this.secrets.get(API_KEY_PREFIX + origin);
    if (!apiKey) {
      return null;
    }

    const client = this.makeClient(origin, apiKey);
    this.clients.set(origin, client);
    return client;
  }

  private makeClient(origin: string, apiKey: string): PanelClient {
    return new PanelClient({ origin, apiKey }, (client) => this.reauth(client));
  }

  async promptSignIn(presetOrigin?: string | null): Promise<PanelClient | null> {
    const origin = await vscode.window.showInputBox({
      title: 'Calagopus: Panel URL',
      prompt: 'The URL of your Calagopus panel',
      value: presetOrigin ?? 'https://',
      ignoreFocusOut: true,
      validateInput: (value) => {
        try {
          const url = new URL(value);
          return url.protocol === 'http:' || url.protocol === 'https:' ? null : 'Must be an http(s) URL';
        } catch {
          return 'Not a valid URL';
        }
      },
    });
    if (!origin) {
      return null;
    }

    const apiKey = await vscode.window.showInputBox({
      title: 'Calagopus: API Key',
      prompt: 'A client API key (Account Settings -> API Keys)',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length === 0 ? 'API key is required' : null),
    });
    if (!apiKey) {
      return null;
    }

    const candidate = new PanelClient({ origin: new URL(origin).origin, apiKey: apiKey.trim() });
    if (!(await this.verify(candidate))) {
      return null;
    }

    await this.remember(candidate.origin, apiKey.trim());
    const client = this.makeClient(candidate.origin, apiKey.trim());
    this.clients.set(client.origin, client);
    this.ephemeral.delete(client.origin);
    this.didChangeEmitter.fire();

    vscode.window.showInformationMessage(`Calagopus: signed in to ${client.origin}.`);
    return client;
  }

  async ephemeralClient(origin: string, apiKey: string): Promise<PanelClient | null> {
    const candidate = new PanelClient({ origin: new URL(origin).origin, apiKey });
    if (!(await this.verify(candidate))) {
      return null;
    }

    const client = this.makeClient(candidate.origin, apiKey);
    this.clients.set(client.origin, client);
    this.ephemeral.add(client.origin);
    this.didChangeEmitter.fire();
    return client;
  }

  async signInWithKey(origin: string, apiKey: string): Promise<PanelClient | null> {
    const candidate = new PanelClient({ origin: new URL(origin).origin, apiKey });
    if (!(await this.verify(candidate))) {
      return null;
    }

    await this.remember(candidate.origin, apiKey);
    const client = this.makeClient(candidate.origin, apiKey);
    this.clients.set(client.origin, client);
    this.ephemeral.delete(client.origin);
    this.didChangeEmitter.fire();

    vscode.window.showInformationMessage(`Calagopus: signed in to ${client.origin}.`);
    return client;
  }

  private async verify(client: PanelClient): Promise<boolean> {
    try {
      await client.ping();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        vscode.window.showErrorMessage('Calagopus: the API key was rejected by the panel.');
      } else {
        vscode.window.showErrorMessage(`Calagopus: could not reach the panel (${err}).`);
      }
      return false;
    }
  }

  private reauth(client: PanelClient): Promise<boolean> {
    const origin = client.origin;
    const inFlight = this.reauthing.get(origin);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.reauthQueue.then(() => this.promptReauth(client));
    const settled = promise.catch(() => false);
    this.reauthQueue = settled.then(() => undefined);
    void settled.then(() => this.reauthing.delete(origin));
    this.reauthing.set(origin, promise);
    return promise;
  }

  private async promptReauth(client: PanelClient): Promise<boolean> {
    const origin = client.origin;
    log.warn(`re-authentication required for ${origin}`);

    const apiKey = await vscode.window.showInputBox({
      title: 'Calagopus: API Key',
      prompt: `Authentication failed for ${origin}. Enter a new client API key.`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length === 0 ? 'API key is required' : null),
    });
    if (!apiKey) {
      return false;
    }

    const candidate = new PanelClient({ origin, apiKey: apiKey.trim() });
    if (!(await this.verify(candidate))) {
      return false;
    }

    client.setApiKey(apiKey.trim());
    if (!this.ephemeral.has(origin)) {
      await this.remember(origin, apiKey.trim());
    }
    this.didChangeEmitter.fire();
    return true;
  }

  async signOut(origin?: string): Promise<void> {
    const origins = await this.origins();
    const targets = origin ? [new URL(origin).origin] : [...new Set([...origins, ...this.ephemeral])];

    for (const target of targets) {
      await this.secrets.delete(API_KEY_PREFIX + target);
      this.clients.delete(target);
      this.ephemeral.delete(target);
    }

    const remaining = origins.filter((o) => !targets.includes(o));
    if (remaining.length > 0) {
      await this.secrets.store(ORIGINS_KEY, JSON.stringify(remaining));
    } else {
      await this.secrets.delete(ORIGINS_KEY);
    }

    this.didChangeEmitter.fire();
  }

  private async remember(origin: string, apiKey: string): Promise<void> {
    await this.secrets.store(API_KEY_PREFIX + origin, apiKey);
    const origins = (await this.origins()).filter((o) => o !== origin);
    origins.unshift(origin);
    await this.secrets.store(ORIGINS_KEY, JSON.stringify(origins));
  }
}
