![app_icon_256](resources/app_icon_256.png)

# JaguarTransfer v1.0.0

A fast, cross-platform **SFTP file manager** built for slow, high-latency links
(VPNs), where SMB/AFP crawl. Built with Electron, React, and TypeScript.

*by Richard Lesh*

---

## Why SFTP?

File-sharing protocols like SMB/CIFS and AFP are chatty and latency-sensitive —
every metadata lookup and lock is a round-trip, so they slow to a crawl over a
VPN. SFTP runs over a single SSH connection and tolerates latency far better,
especially with request pipelining and parallel transfers (coming in a later
milestone).

## Status — Milestone 1

This is the M1 scaffold:

- App shell with splash/about dialogs (dynamic version).
- **Connection manager** — create, edit, and delete site profiles.
- **Connect** with three auth methods: private key (+ optional passphrase),
  **ssh-agent**, and password / keyboard-interactive.
- **Host-key TOFU** — trust-on-first-use verification with a persisted
  trusted-hosts store; warns loudly if a host key changes.
- **Single remote pane** — browse the start directory, navigate in/out, refresh,
  with name / size / modified / permissions.

Planned next: local pane, rename/delete/mkdir on both sides (M2), the pipelined
parallel transfer engine + queue (M3), resume/reconnect/compression tuning (M4),
and packaging/signing polish (M5). Jump-host/bastion support is a fast-follow.

## Data & security

- **Site profiles** → `~/.jaguartransfer-sites.json` (no secrets).
- **Trusted host keys** → `~/.jaguartransfer-known-hosts.json` (TOFU).
- **App settings** → `~/.jaguartransfer-settings.json`.
- **Secrets** (passwords, key passphrases) → the **OS keychain** via
  `@napi-rs/keyring` (Keychain / Credential Manager / libsecret), referenced by
  site id — never written to the JSON files.
- The renderer is sandboxed; all filesystem/network/secret access goes through
  the main process behind a typed IPC bridge (`window.jaguar`).

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

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE).

© 2026 Richard Lesh
