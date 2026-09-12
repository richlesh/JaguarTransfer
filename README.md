![app_icon_256](resources/app_icon_256.png)

# TransferJaguar v1.1.0

A fast, cross-platform **SFTP file manager** built for slow, high-latency links
(VPNs), where SMB/AFP crawl. Built with Electron, React, and TypeScript.

*by Richard Lesh*

---

## Why SFTP?

File-sharing protocols like SMB/CIFS and AFP are chatty and latency-sensitive —
every metadata lookup and lock is a round-trip, so they slow to a crawl over a
VPN. SFTP runs over a single SSH connection and tolerates latency far better.
TransferJaguar leans into that with a streaming transfer engine, resume, and
optional compression, so moving files over a slow link stays responsive.

---

## Features

### Connections
- **Multi-protocol** — connect over **SFTP (SSH)**, **WebDAV (HTTP/HTTPS)**,
  **FTP / FTPS**, **Dropbox**, **OneDrive**, or **Google Drive** (OAuth); pick
  the protocol per site. See [Protocols](#protocols) for capability differences
- **Connection manager** — save, edit, and delete site profiles (host, port,
  username, start directory, options), with connect / edit / delete right on
  each site in the sidebar
- **Three auth methods** — private key (with optional passphrase), **ssh-agent**,
  and **password / keyboard-interactive**
- **Host-key TOFU** — trust-on-first-use verification against a persisted
  trusted-hosts store; a loud warning if a previously-trusted key changes
  (possible MITM)
- **Jump host / bastion** — connect through a bastion via SSH channel forwarding,
  with its own host/port/user/auth and independent host-key verification
- **Compression** — optional per-site `zlib@openssh.com` compression for slow links
- **Auto-reconnect** — dropped SSH sessions reconnect automatically with
  exponential backoff (re-dialing the bastion when used); a header indicator
  shows "reconnecting…"

### Dual-pane browsing
- **Local + remote panes** side by side — the local filesystem on one side, the
  connected server on the other
- **Directory tree viewer** — a toggleable, collapsible directories-only tree
  above each file list (lazy-loaded, expand/collapse triangles); click a folder
  to make it the current directory. A draggable divider resizes tree vs. list
- **Sortable columns** — click Name / Size / Modified to sort, click again to
  reverse, with a ▲/▼ indicator; **resizable Name column**
- **Directory placement** — choose whether folders sort at the top, inline with
  files, or at the bottom (Settings)
- **Show hidden files** — toggle dotfiles in both the list and the tree (Settings)
- **File operations on both sides** — rename, delete (recursive, with
  confirmation), and new folder
- **Multi-select** — Cmd/Ctrl-click to toggle, Shift-click for a range; delete
  and transfer act on the whole selection

### Transfers
- **Streaming transfer engine** — upload and download over SFTP with manual flow
  control for reliable pause behavior, recursive directory transfers, and a
  bounded concurrency pool for many files
- **Drag-and-drop** between panes, or explicit **Upload → / ← Download** buttons
- **Transfer queue** — a fixed bottom panel listing each transfer newest-first,
  with a progress bar, %, bytes, file counts, throughput, and ETA
- **Pause / resume / cancel** mid-transfer; confirmation before canceling an
  active transfer, and before quitting while transfers are in progress
- **Resume partial transfers** — an interrupted transfer continues from the
  partial file's byte offset instead of restarting
- **Conflict handling** — when a destination exists: keep both (auto-rename),
  overwrite, or skip (Settings default)
- **Optional checksum verify** — verify each file with SHA-256 after transfer
  (uses the server's `sha256sum`; off by default)

### App
- **Light / dark theme** (Settings), applied throughout including the dialogs
- **Settings** — theme, show-hidden-files, directory placement, conflict policy,
  and checksum verify; reachable from the menu (⌘, / Ctrl+,) or the header gear
- **License key** — enter an email + key to license the app; a periodic purchase
  splash appears for unlicensed users (on launch and every 10th transfer request,
  where a multi-select counts as one). The About box thanks licensed users
- **Native menus** and splash / about dialogs
- **Cross-platform** — macOS, Windows, and Linux (x64 + arm64)

---

## Protocols

TransferJaguar speaks several remote protocols; choose one per site in the site
editor. All browsing, transfers, the queue, drag-and-drop, and conflict handling
work the same way regardless of protocol — only the connection setup and a few
capabilities differ.

### SFTP (SSH)
The original, most fully-featured path. Private-key / ssh-agent / password auth,
host-key TOFU, jump-host/bastion, compression, auto-reconnect, resume in **both**
directions, and optional SHA-256 checksum verification (via `sha256sum` on the
server).

**Optional rsync transfers.** An SFTP site can opt in to using the local
`rsync` binary (over SSH) for file copies, which delta-encodes transfers — only
changed bytes move, a big win on slow links and re-syncs. Enable it in the site
editor ("Use rsync for file copies"), where you can set the path to the `rsync`
executable (with a platform default and a Browse button). Browsing, rename,
mkdir, and delete still go through the SFTP connection; only the byte transfer
uses rsync. Requirements and limits:
- **Key or ssh-agent auth only** — rsync drives the system `ssh`, which can't be
  fed a password non-interactively. Password-auth sites fall back to the
  built-in transfer.
- **No jump host** (v1) and the `rsync` binary must exist — otherwise it falls
  back to the built-in transfer automatically ("when available").
- **No mid-transfer pause** for rsync copies (cancel works); resume is native
  via `--partial --append-verify`.
- rsync's `ssh` uses its own `known_hosts` (accepting new keys automatically),
  separate from the app's host-key TOFU store.

### WebDAV (HTTP/HTTPS)
For self-hosted cloud (**Nextcloud**/**ownCloud**), **SharePoint**, **Box**, and
NAS boxes. Configure a site with:
- **URL** — the full WebDAV collection URL, e.g.
  `https://cloud.example.com/remote.php/dav/files/alice/`
- **Authentication** — **Basic** (username + password), **Bearer token**, or
  **None** (public). The secret goes to the OS keychain, like SFTP secrets.
- **Start directory** — optional path within the collection (defaults to `/`).

Runs over a single TLS connection (port 443), so it's proxy/firewall-friendly.
Security relies on the server's TLS certificate chain (there is no SSH host-key
TOFU). SSH-only options — private keys, ssh-agent, compression, and jump hosts —
are hidden for WebDAV sites.

### FTP / FTPS
For legacy servers and shared hosting that only speak FTP. Choose a **security
mode** per site:
- **Explicit FTPS** — FTP over TLS via `AUTH TLS` (usually port 21). Preferred.
- **Implicit FTPS** — TLS from connect (usually port 990), for older servers.
- **Plain FTP** — unencrypted. The editor shows a clear warning; use only when
  the server offers nothing better, ideally on a trusted network.

FTP allows only one operation per control connection, so each session opens a
small **pool** of connections to keep transfers concurrent. Because FTP has no
mid-transfer pause, the **Pause** control is hidden for FTP transfers; **cancel**
works, and interrupted transfers **resume from the partial offset** where the
server supports it (`REST`/`APPE`), falling back to a restart otherwise. There's
no SSH host-key TOFU (FTPS relies on the server's TLS certificate) and no
checksum verification.

### Capability differences

| Capability            | SFTP            | WebDAV                     | FTP / FTPS                 | Dropbox                    | OneDrive                   | Google Drive               |
| --------------------- | --------------- | -------------------------- | -------------------------- | -------------------------- | -------------------------- | -------------------------- |
| Browse / rename / mkdir / delete | ✅ | ✅                        | ✅                         | ✅                         | ✅                         | ✅                         |
| Resume **downloads**  | ✅              | ✅ (HTTP `Range`)          | ✅ (`REST`, best-effort)¹  | ✅ (HTTP `Range`)          | ✅ (HTTP `Range`)          | ✅ (binary; exports whole)³|
| Resume **uploads**    | ✅              | ❌ (restarts from 0)²      | ✅ (`APPE`, best-effort)¹  | ❌ (restarts from 0)       | ❌ (restarts from 0)       | ❌ (restarts from 0)       |
| Pause mid-transfer    | ✅              | ✅                         | ❌ (control hidden)        | ✅ downloads / ❌ uploads  | ✅ downloads / ❌ uploads  | ✅ downloads / ❌ uploads  |
| Checksum verify       | ✅ (`sha256sum`)| ❌                         | ❌                         | ❌                         | ❌                         | ❌                         |
| Host-key TOFU         | ✅              | — (TLS/PKI)                | — (TLS/PKI for FTPS)       | — (OAuth/TLS)              | — (OAuth/TLS)              | — (OAuth/TLS)              |
| Jump host / compression | ✅            | —                          | —                          | —                          | —                          | —                          |

### Google Drive (OAuth)
Connect a **Google Drive** account with OAuth 2.0 — no password is stored. Pick
the Google Drive protocol and click **Connect to Google Drive**; tokens are
stored in the OS keychain and refreshed transparently. An optional start folder
scopes the initial view (default is My Drive root). Uploads use Drive's resumable
upload; binary downloads resume via HTTP `Range`.

**Google-format files** (Docs, Sheets, Slides, …) have no raw bytes, so they're
shown in listings and **downloaded by exporting**: Docs → `.docx`, Sheets →
`.xlsx`, Slides → `.pptx`, and other Google formats → `.pdf`. The matching
extension is appended to the downloaded filename.

**Build setup (maintainers).** In the **Google Cloud Console**: create a project,
enable the **Google Drive API**, configure the **OAuth consent screen**
(External; add yourself as a Test user), then create an **OAuth client ID** of
type **Desktop app**. Register the redirect URI `http://localhost:53682/`. Put
the client ID in `electron/oauth/provider.ts` (`GOOGLE_PROVIDER.clientId`) or set
the `GOOGLE_CLIENT_ID` environment variable. Google Desktop clients also issue a
**client secret** that must be sent at the token endpoint even with PKCE — put it
in `GOOGLE_PROVIDER.clientSecret` or set `GOOGLE_CLIENT_SECRET`. The flow uses
PKCE + loopback with `access_type=offline` for a refresh token.

¹ FTP resume depends on server support; a failed resume surfaces as a task error
and can be retried (e.g. with Overwrite) to restart cleanly.
² WebDAV `PUT` has no portable append, so an interrupted upload starts over.
³ Google-native exports (Docs/Sheets/Slides) download whole (no `Range`); regular
binary files resume from the partial offset.

### OneDrive (OAuth)
Connect a **OneDrive** account (personal or work/school) with OAuth 2.0 via
Microsoft Graph — no password is stored. Pick the OneDrive protocol and click
**Connect to OneDrive**; the app stores access + refresh tokens in the OS
keychain and refreshes them transparently. An optional start folder scopes the
initial view (default is the drive root). Large uploads use Graph upload
sessions; downloads resume via HTTP `Range`.

**Build setup (maintainers).** Register an app in the **Azure Portal** (Azure
Active Directory → App registrations). Add it as a *public client / Mobile and
desktop applications* with the redirect URI `http://localhost:53682/`, and under
**API permissions** add the delegated Microsoft Graph scopes `offline_access`,
`User.Read`, and `Files.ReadWrite.All`. Use the **common** tenant so personal and
work accounts can sign in. Put the Application (client) ID in
`electron/oauth/provider.ts` (`ONEDRIVE_PROVIDER.clientId`) or set the
`ONEDRIVE_CLIENT_ID` environment variable. PKCE + loopback means no client
secret is needed.

### Dropbox (OAuth)
Connect a **Dropbox** account with OAuth 2.0 — no password is stored. In the site
editor, pick the Dropbox protocol and click **Connect to Dropbox**: a browser
window opens Dropbox's consent screen, and on approval the app stores the access
and refresh tokens in the OS keychain (never in the JSON files). Access tokens
are refreshed transparently. An optional start folder scopes the initial view;
the default is the account root. Large uploads use Dropbox upload sessions
automatically; downloads resume via HTTP `Range`.

**Build setup (maintainers).** Dropbox OAuth needs an app **client ID** (app
key), created at <https://www.dropbox.com/developers/apps> as a *Scoped access*
/ *Full Dropbox* app. Register the exact redirect URI
`http://localhost:53682/` (Dropbox matches redirect URIs exactly, so a fixed
loopback port is used rather than a random one). Put the key in
`electron/oauth/provider.ts` (`DROPBOX_PROVIDER.clientId`) or set the
`DROPBOX_CLIENT_ID` environment variable. The flow uses **PKCE** with a
**loopback redirect**, so no client secret is needed or shipped. Until a real
client ID is provided, the Dropbox option reports that it isn't configured.

¹ FTP resume depends on server support; a failed resume surfaces as a task error
and can be retried (e.g. with Overwrite) to restart cleanly.
² WebDAV `PUT` has no portable append, so an interrupted upload starts over.



All planned milestones are implemented: connection management + auth + host-key
TOFU (M1), dual-pane browsing and file operations (M2), the transfer engine +
queue + drag-and-drop (M3), resume / auto-reconnect / conflict handling /
checksum verify (M4), and signed packaging + release workflows (M5), plus
jump-host/bastion support. Live end-to-end testing against production servers is
ongoing.

## Data & security

- **Site profiles** → `~/.transferjaguar-sites.json` (no secrets).
- **Trusted host keys** → `~/.transferjaguar-known-hosts.json` (TOFU).
- **App settings** → `~/.transferjaguar-settings.json`.
- **Secrets** (passwords, key passphrases — including a separate bastion
  credential) → the **OS keychain** via `@napi-rs/keyring` (Keychain / Windows
  Credential Manager / libsecret), referenced by site id — never written to the
  JSON files.
- **OAuth tokens** (Dropbox / OneDrive / Google Drive access + refresh tokens) →
  the same **OS keychain**, stored per site and refreshed transparently; never
  written to the JSON files.
- The renderer is sandboxed; all filesystem/network/secret access goes through
  the main process behind a typed IPC bridge (`window.transferJaguar`).

## Tech Stack

- [Electron](https://www.electronjs.org)
- [React](https://react.dev) + [Vite](https://vitejs.dev)
- [TypeScript](https://www.typescriptlang.org)
- [ssh2](https://github.com/mscdex/ssh2) — SSH/SFTP client
- [webdav](https://github.com/perry-mitchell/webdav-client) — WebDAV client
- [basic-ftp](https://github.com/patrickjuchli/basic-ftp) — FTP / FTPS client
- [@napi-rs/keyring](https://github.com/napi-rs/keyring-node) — OS keychain

## Development

```bash
npm install
npm run dev         # Vite renderer + Electron with hot reload
npm run build       # Build renderer and Electron main
npm run typecheck   # Type-check renderer and Electron projects
```

## Building distributables

```bash
npm run dist:mac:arm64     # or :x64
npm run dist:win:x64       # or :arm64
npm run dist:linux:x64     # or :arm64
```

## Releasing (signed, via GitHub Actions)

Pushing a **tag** (e.g. `1.0.0`) — or running a workflow manually with a tag —
triggers the mac/win/linux build workflows, which produce **signed** artifacts
and upload them to a **draft** GitHub Release.

Required repository **secrets**:

- `LICENSE_SALT` — the production HMAC salt written into `license.cjs` at build
  time (the committed file is gitignored; without this secret keys won't validate).
- **OAuth client credentials** (injected into the compiled `provider.js` at build
  time by `scripts/inject-oauth.mjs`; the committed source ships placeholders):
  `DROPBOX_CLIENT_ID`, `ONEDRIVE_CLIENT_ID`, `GOOGLE_CLIENT_ID`, and
  `GOOGLE_CLIENT_SECRET`. Any that are unset simply stay as placeholders (that
  provider then reports "not configured").
- **macOS signing + notarization**: `APPLE_CERTIFICATE_BASE64`,
  `APPLE_CERTIFICATE_PASSWORD` (Developer ID cert .p12, base64-encoded), and the
  App Store Connect API key for notarization: `APPLE_API_KEY` (the .p8 contents),
  `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`. The signing identity/Team ID
  (`RICHARD A LESH (MMZ3Y97NTP)` / `MMZ3Y97NTP`) is set in `package.json` /
  the workflow.
- **Windows signing** (Azure Trusted Signing): `AZURE_CLIENT_ID`,
  `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_SIGNING_ENDPOINT`,
  `AZURE_SIGNING_ACCOUNT_NAME`, `AZURE_SIGNING_CERTIFICATE_PROFILE_NAME`.

Linux `.deb`/`.rpm` are unsigned (standard). macOS hardened-runtime entitlements
are in `entitlements.plist`; `afterPack.cjs` strips stray xattrs before signing.


## License

GNU General Public License v3.0 — see [LICENSE](LICENSE).

© 2026 Richard Lesh
