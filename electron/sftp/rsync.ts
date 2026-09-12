// rsync-over-SSH transfer helper for the SFTP backend (Electron main process).
//
// When an SFTP site opts in (site.useRsync) and rsync is usable, file copies are
// performed by shelling out to the local `rsync` binary, which reuses the
// system `ssh` for transport and delta-encodes the transfer (great on slow
// links / re-syncs). This is an SFTP-backend implementation detail: browsing,
// rename/mkdir/delete still go through the ssh2 SFTP session.
//
// Deliberate v1 limitations (see isRsyncUsable): key/agent auth only (password
// can't drive the non-interactive external ssh), no jump host, and the binary
// must exist. When not usable, the SFTP backend falls back to its built-in
// streaming transfer.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Site } from "../../src/shared/types.js";
import type { TransferControl } from "../backend/types.js";

/** A reasonable default path to the rsync executable per platform. Windows has
 *  no bundled rsync, so we default to empty and let the user browse for one
 *  (e.g. cwRsync / MSYS2 / Git-for-Windows). */
export function defaultRsyncPath(): string {
  switch (process.platform) {
    case "darwin":
      return "/usr/bin/rsync";
    case "linux":
      return "/usr/bin/rsync";
    default:
      return ""; // Windows: user must point at an rsync.exe
  }
}

/** The rsync binary path for a site (its configured path, else the default). */
export function rsyncPathFor(site: Site): string {
  return (site.rsyncPath && site.rsyncPath.trim()) || defaultRsyncPath();
}

/** Whether rsync can be used for this site right now. Requires: opt-in, key or
 *  agent auth (password can't drive the external ssh non-interactively), no jump
 *  host (ProxyJump plumbing is out of scope for v1), and an existing binary. */
export function isRsyncUsable(site: Site): boolean {
  if (!site.useRsync) return false;
  if (site.authMethod !== "key" && site.authMethod !== "agent") return false;
  if (site.jump?.enabled) return false;
  const bin = rsyncPathFor(site);
  if (!bin) return false;
  try {
    return existsSync(bin);
  } catch {
    return false;
  }
}

/** Expand a leading ~ to the user's home (rsync's own ssh handles server-side ~). */
function expandHome(p: string): string {
  if (!p.startsWith("~")) return p;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return home ? p.replace(/^~(?=$|[/\\])/, home) : p;
}

/** Build the `ssh` transport command rsync should use via -e/--rsh. */
function sshTransport(site: Site): string {
  const parts = ["ssh", "-p", String(site.port || 22)];
  // rsync's ssh keeps its OWN host-key store, separate from the app's TOFU and
  // from the user's global ~/.ssh/known_hosts. We point it at a dedicated app
  // file and use accept-new so: (a) brand-new hosts are trusted automatically,
  // and (b) we never collide with a changed/stale key in the user's global
  // known_hosts (which would trigger ssh's "@@@@ REMOTE HOST IDENTIFICATION HAS
  // CHANGED" refusal). Verification still happens against our own file.
  const knownHosts = join(homedir(), ".transferjaguar-rsync-known-hosts");
  parts.push("-o", "StrictHostKeyChecking=accept-new");
  parts.push("-o", `UserKnownHostsFile=${knownHosts}`);
  // Silence benign info/warning chatter (e.g. "Warning: Permanently added ...
  // to the list of known hosts") so it can't be mistaken for an error; genuine
  // errors are still printed at ERROR level.
  parts.push("-o", "LogLevel=ERROR");
  parts.push("-o", "BatchMode=yes"); // never prompt (we've excluded password auth)
  if (site.authMethod === "key" && site.privateKeyPath) {
    // Offer the configured key, but do NOT set IdentitiesOnly: a passphrase-
    // protected key can't be unlocked non-interactively from the file, so we
    // also let ssh use matching identities from the agent (loaded via ssh-add).
    parts.push("-i", expandHome(site.privateKeyPath));
  }
  return parts.join(" ");
}

/** Remote endpoint string for rsync: user@host:/absolute/path (path passed as a
 *  separate argv entry, so no shell quoting is needed — spawn without a shell). */
function remoteEndpoint(site: Site, remotePath: string): string {
  const user = site.username ? `${site.username}@` : "";
  return `${user}${site.host}:${remotePath}`;
}

/** Parse a running byte count from an `--info=progress2` line. Those lines look
 *  like: "   32,768,000  42%  5.00MB/s    0:00:03". Returns the byte count or -1. */
function parseProgressBytes(chunk: string): number {
  let last = -1;
  // Progress lines are carriage-return separated during a transfer.
  for (const raw of chunk.split(/[\r\n]+/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([\d,]+)\s+\d+%/.exec(line);
    if (m) {
      const n = Number(m[1].replace(/,/g, ""));
      if (Number.isFinite(n)) last = n;
    }
  }
  return last;
}

/**
 * Pull a meaningful message out of rsync's stderr. rsync prints its own errors
 * as "rsync: ..." / "rsync error: ..." lines, but on an unrecognized option it
 * also dumps a multi-line usage banner (whose last line is literally
 * "source ... directory"). Prefer the real error lines and ignore the banner.
 */
function extractRsyncError(stderr: string, code: number | null): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // ssh host-key problems print a banner bordered by rows of '@' plus a
  // "HOST IDENTIFICATION HAS CHANGED" / "POSSIBLE ... SPOOFING" message. Surface
  // a clear, actionable message rather than the '@@@@' border line.
  if (lines.some((l) => /HOST IDENTIFICATION HAS CHANGED|POSSIBLE DNS SPOOFING|HOST KEY VERIFICATION FAILED/i.test(l))) {
    return (
      "the server's SSH host key didn't match the one rsync had on record. " +
      "Remove the stale entry from ~/.transferjaguar-rsync-known-hosts (or the host's " +
      "line in ~/.ssh/known_hosts) and try again."
    );
  }

  // A key/agent auth failure is the most actionable cause; surface it with a hint.
  if (lines.some((l) => /permission denied/i.test(l))) {
    return (
      "SSH authentication failed (Permission denied). rsync needs a private key " +
      "or ssh-agent identity that the server accepts — check the site's key path, " +
      "and that the matching public key is in the server's authorized_keys."
    );
  }

  const rsyncLine = lines.find((l) => /^rsync(?: error)?:/i.test(l));
  if (rsyncLine) return rsyncLine.replace(/^rsync(?: error)?:\s*/i, "");

  // Benign ssh chatter that must never be reported as the failure reason.
  const isNoise = (l: string): boolean =>
    /^usage:/i.test(l) ||
    /^\[/.test(l) ||
    /^source \.\.\. directory$/i.test(l) ||
    /^@+$/.test(l) ||
    // "Warning: Permanently added 'host' (ED25519) to the list of known hosts."
    /^warning: permanently added/i.test(l) ||
    /to the list of known hosts/i.test(l);

  const meaningful = lines.find((l) => !isNoise(l));
  return meaningful || `rsync exited with code ${code ?? "unknown"}`;
}

/**
 * Run an rsync transfer as a TransferControl. Direction is implied by which of
 * source/dest is the remote endpoint (built by the callers below). Progress is
 * parsed from rsync's --progress output; cancel() kills the child; resume is
 * native via --partial. Pause is not supported (no-op).
 */
function runRsync(bin: string, args: string[], onBytes: (n: number) => void, startOffset: number): TransferControl {
  let child: ChildProcess | null = null;
  let canceled = false;

  const done = new Promise<"completed" | "canceled">((resolve, reject) => {
    child = spawn(bin, args, { windowsHide: true });
    let stderr = "";

    const handleProgress = (buf: Buffer) => {
      const bytes = parseProgressBytes(buf.toString());
      if (bytes >= 0) onBytes(startOffset + bytes);
    };
    // rsync writes progress to stdout; some builds interleave on stderr.
    child.stdout?.on("data", handleProgress);
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString();
      handleProgress(b);
    });

    child.on("error", (e) => {
      if (canceled) return resolve("canceled");
      reject(e instanceof Error ? e : new Error(String(e)));
    });
    child.on("close", (code, signal) => {
      if (canceled || signal) return resolve("canceled");
      if (code === 0) return resolve("completed");
      reject(new Error(`rsync failed: ${extractRsyncError(stderr, code)}`));
    });
  });

  return {
    done,
    pause: () => {
      /* rsync has no mid-transfer pause; no-op. */
    },
    resume: () => {
      /* no-op */
    },
    cancel: () => {
      canceled = true;
      try { child?.kill("SIGTERM"); } catch { /* noop */ }
    },
  };
}

/** Common rsync flags, chosen for portability across rsync versions — including
 *  macOS's openrsync (protocol 29, rsync 2.6.x-era), which rejects rsync-3.x-only
 *  options like --append-verify and --info=progress2. --partial keeps partially
 *  transferred files so an interrupted copy resumes on retry; --progress prints a
 *  parseable per-file progress line; -t preserves mtimes so unchanged data is
 *  skipped on re-sync. */
function baseArgs(site: Site): string[] {
  return [
    "--partial", // keep partial files for resume on retry
    "--progress", // per-file progress line (portable; parsed for bytes)
    "-t", // preserve mtimes (lets rsync skip unchanged data)
    "-e",
    sshTransport(site),
  ];
}

/** Download a remote file to a local path via rsync. */
export function rsyncDownload(
  site: Site,
  remotePath: string,
  localPath: string,
  onBytes: (n: number) => void,
  startOffset = 0
): TransferControl {
  const bin = rsyncPathFor(site);
  const args = [...baseArgs(site), remoteEndpoint(site, remotePath), localPath];
  return runRsync(bin, args, onBytes, startOffset);
}

/** Upload a local file to a remote path via rsync. */
export function rsyncUpload(
  site: Site,
  localPath: string,
  remotePath: string,
  onBytes: (n: number) => void,
  startOffset = 0
): TransferControl {
  const bin = rsyncPathFor(site);
  const args = [...baseArgs(site), localPath, remoteEndpoint(site, remotePath)];
  return runRsync(bin, args, onBytes, startOffset);
}
