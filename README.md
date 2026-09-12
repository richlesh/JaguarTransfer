![app_icon_256](resources/app_icon_256.png)

# TransferJaguar v1.0.0

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

## Status

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
- The renderer is sandboxed; all filesystem/network/secret access goes through
  the main process behind a typed IPC bridge (`window.transferJaguar`).

## Tech Stack

- [Electron](https://www.electronjs.org)
- [React](https://react.dev) + [Vite](https://vitejs.dev)
- [TypeScript](https://www.typescriptlang.org)
- [ssh2](https://github.com/mscdex/ssh2) — SSH/SFTP client
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
