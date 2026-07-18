![Calagopus Logo](https://calagopus.com/fulllogo.png)

# Calagopus for VSCode

Browse and edit [Calagopus](https://calagopus.com) server files and access the server console directly from VS Code.

## Features

- Mount server files as a workspace folder over a virtual `calagopus://` filesystem.
- Edit, create, rename, and delete files and directories remotely with native VS Code tooling.
- Search across server files by name and content (when the proposed search APIs are enabled).
- Attach to the live server console as an integrated terminal, with full output streaming and command input.
- Collaborate on server files in real time - edits and cursors are shared live and saves are coordinated when multiple people open the same file.
- Browse a file's revision history in the explorer, diff any revision against the current file or the previous one, and restore old versions.
- View server state in the status bar and trigger power actions (start, stop, restart, kill).
- Open servers and consoles via deep links using the `calagopus` URI handler.
- Secure, persistent sign-in backed by VS Code's secret storage.

## Commands

| Command | Description |
| --- | --- |
| `Calagopus: Sign In` | Authenticate with your Calagopus panel. |
| `Calagopus: Sign Out` | Clear stored credentials. |
| `Calagopus: Open Server Files` | Pick a server and mount its files as a workspace folder. |
| `Calagopus: Open Server Console` | Pick a server and attach to its console. |
| `Calagopus: Server Power Action` | Start, stop, restart, or kill the active server. |
| `Calagopus: Enable File Collaboration` | Turn on real-time collaborative editing. |
| `Calagopus: Disable File Collaboration` | Turn off real-time collaborative editing. |

The **File History** view also contributes context commands (Refresh, View Diff Against Current File, Compare to Previous Revision, Restore Revision into Editor) that appear on its items rather than in the command palette.

## Deep links

The extension registers a `calagopus` URI handler. Open a server (mounting its files as a workspace folder) with:

```
vscode://calagopus.calagopus/open?origin=<panel-url>&server=<server-uuid>
```

| Param | Description |
| --- | --- |
| `origin` | Panel base URL, e.g. `https://panel.example.com`. Required. |
| `server` | Server UUID. Required. |
| `apiKey` | Optional API key for an ephemeral, non-persisted session. |
| `console` | When truthy (`1`/`true`), also attach to the server console. |
| `file` | Optional path (relative to the server root) to open in the editor after mounting. |

When the link opens into a fresh window, the file explorer is revealed automatically.

### Automatic sign-in via callback

Whenever you sign in without supplying a key - both via a deep link and via the **Calagopus: Sign In** command - the extension provisions an API key for you in the browser instead of asking you to paste one:

1. It starts a short-lived loopback HTTP server and opens the panel's `/account/api-keys/create` page in your browser, passing the requested key name, permissions, and a `callback_url`.
2. After you approve, the panel redirects to the callback URL with the new key, which the extension persists to VS Code's secret storage.
3. A progress notification is shown while the round-trip happens; you can also paste an API key manually as a fallback if the callback never arrives.

This works across editors (including VS Code forks that don't register a custom URI scheme) and is forwarded automatically in Remote and Codespaces environments.

## Real-time collaboration

When collaboration is enabled, opening a server file joins a live editing session shared with anyone else who has that file open:

- Edits are synchronized as you type using a CRDT (Yjs), so concurrent changes merge without conflicts.
- Remote participants' cursors and selections are shown inline, and the file's decoration and a status bar item indicate who else is currently editing.
- Saves are coordinated through the panel so collaborators don't clobber each other's work.

Collaboration is on by default. Toggle it with the **Calagopus: Enable/Disable File Collaboration** commands or the `calagopus.collaboration.enabled` setting.

## File history

Mounting a server exposes a **File History** view in the Explorer. Select a Calagopus file to list its stored revisions, each showing the author, age, size, and whether it's a full snapshot. From a revision you can:

- **View Diff Against Current File** - compare the revision to the file's current contents.
- **Compare to Previous Revision** - diff the revision against the one before it.
- **Restore Revision into Editor** - load an older version back into the editor.

## Requirements

- VS Code `^1.120.0`
- A Calagopus account with access to one or more servers

## Building

```bash
pnpm install
pnpm compile
```

To produce an installable `.vsix` and install it locally:

```bash
pnpm package
pnpm code:install
```
