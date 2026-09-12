// SFTP engine (Electron main process). Wraps ssh2 to: open one persistent SSH
// connection per session, verify the host key against our TOFU store, and read
// remote directories. Transfers (chunked/pipelined) come in M3.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { Client } from "ssh2";
import type { SFTPWrapper, ConnectConfig } from "ssh2";
import type { Site, RemoteEntry, RemoteListing, HostKeyPrompt } from "../../src/shared/types.js";
import { verifyHostKey } from "../knownHosts.js";
import { getSecret } from "../secrets.js";

interface Session {
  id: string;
  site: Site;
  client: Client;
  sftp: SFTPWrapper;
}

const sessions = new Map<string, Session>();

/** OpenSSH-style SHA-256 fingerprint (base64, no padding) of a host key. */
function fingerprintSha256(key: Buffer): string {
  return createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}

/** Expand a leading ~ in a path to the user's home directory. */
function expandHome(p: string): string {
  return p.startsWith("~") ? p.replace(/^~(?=$|\/)/, homedir()) : p;
}

/** Map an ssh2 attrs/longname into our RemoteEntry kind. */
function entryKind(longname: string, attrs: { isDirectory(): boolean; isSymbolicLink?(): boolean }): RemoteEntry["kind"] {
  if (attrs.isDirectory()) return "directory";
  if (typeof attrs.isSymbolicLink === "function" && attrs.isSymbolicLink()) return "symlink";
  if (longname.startsWith("l")) return "symlink";
  if (longname.startsWith("d")) return "directory";
  if (longname.startsWith("-")) return "file";
  return "file";
}

export interface ConnectOutcome {
  ok: true;
  sessionId: string;
  cwd: string;
}
export type EngineConnectResult =
  | ConnectOutcome
  | { ok: false; error: string }
  | { ok: false; needsHostKeyTrust: true; prompt: HostKeyPrompt };

/**
 * Build the ssh2 auth part of the connect config from the site + its stored
 * secret. Supports: key (+ optional passphrase), ssh-agent, and
 * password/keyboard-interactive.
 */
function buildAuth(site: Site): Partial<ConnectConfig> {
  const secret = getSecret(site.id) ?? undefined;
  if (site.authMethod === "agent") {
    // Use the running agent. On Windows, ssh2 accepts the named-pipe constant.
    const agent = process.env.SSH_AUTH_SOCK || (process.platform === "win32" ? "pageant" : undefined);
    return { agent, agentForward: false };
  }
  if (site.authMethod === "key") {
    if (!site.privateKeyPath) throw new Error("This site uses key auth but has no private key path.");
    const privateKey = readFileSync(expandHome(site.privateKeyPath));
    return secret ? { privateKey, passphrase: secret } : { privateKey };
  }
  // password (with keyboard-interactive fallback handled below)
  return { password: secret };
}

/**
 * Connect to a site. Verifies the host key first (TOFU): if the key is unknown
 * or changed, resolves with needsHostKeyTrust so the UI can prompt; on retry
 * (after trustHostKey) the key will verify and the connection proceeds.
 */
export function connect(site: Site): Promise<EngineConnectResult> {
  return new Promise((resolve) => {
    const client = new Client();
    let settled = false;
    const done = (r: EngineConnectResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const auth = (() => {
      try {
        return buildAuth(site);
      } catch (e) {
        return e instanceof Error ? e : new Error(String(e));
      }
    })();
    if (auth instanceof Error) {
      done({ ok: false, error: auth.message });
      return;
    }

    const config: ConnectConfig = {
      host: site.host,
      port: site.port || 22,
      username: site.username,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      tryKeyboard: site.authMethod === "password",
      ...(site.compression ? { algorithms: { compress: ["zlib@openssh.com", "zlib", "none"] } } : {}),
      ...auth,
      // TOFU host-key verification. Returning false rejects the connection; we
      // signal the specific reason via the closure below.
      hostVerifier: (keyBuf: Buffer) => {
        const fp = fingerprintSha256(keyBuf);
        const status = verifyHostKey(site.host, site.port || 22, fp);
        if (status === "trusted") return true;
        pendingPrompt = {
          host: site.host,
          port: site.port || 22,
          keyType: detectKeyType(keyBuf),
          fingerprintSha256: fp,
          changed: status === "changed",
        };
        return false; // triggers the 'error' event; we translate it below
      },
    };

    let pendingPrompt: HostKeyPrompt | null = null;

    // keyboard-interactive: answer prompts with the stored password (covers
    // servers that only offer keyboard-interactive, and simple OTP prompts).
    client.on("keyboard-interactive", (_name, _instr, _lang, _prompts, finish) => {
      const secret = getSecret(site.id) ?? "";
      finish([secret]);
    });

    client.on("ready", () => {
      client.sftp((err, sftp) => {
        if (err) {
          client.end();
          done({ ok: false, error: `SFTP subsystem failed: ${err.message}` });
          return;
        }
        const id = randomUUID();
        sessions.set(id, { id, site, client, sftp });
        const start = site.startDir?.trim();
        if (start) {
          done({ ok: true, sessionId: id, cwd: start });
        } else {
          // Resolve the server's default (home) directory.
          sftp.realpath(".", (rpErr, abs) => {
            done({ ok: true, sessionId: id, cwd: rpErr ? "/" : abs });
          });
        }
      });
    });

    client.on("error", (err: Error) => {
      if (pendingPrompt) {
        done({ ok: false, needsHostKeyTrust: true, prompt: pendingPrompt });
      } else {
        done({ ok: false, error: err.message });
      }
    });

    try {
      client.connect(config);
    } catch (e) {
      done({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

/** Best-effort host key type from the raw key blob (starts with the algorithm name). */
function detectKeyType(keyBuf: Buffer): string {
  // SSH wire format: uint32 length, then the algorithm name string.
  try {
    const len = keyBuf.readUInt32BE(0);
    return keyBuf.subarray(4, 4 + len).toString("ascii");
  } catch {
    return "ssh-key";
  }
}

export function disconnect(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  try {
    s.client.end();
  } catch {
    // ignore
  }
  sessions.delete(sessionId);
}

export function disconnectAll(): void {
  for (const id of [...sessions.keys()]) disconnect(id);
}

/** Read a remote directory into a sorted RemoteListing (dirs first, then name). */
export function list(sessionId: string, path: string): Promise<RemoteListing> {
  const s = sessions.get(sessionId);
  if (!s) return Promise.reject(new Error("Not connected (unknown session)."));
  const target = path && path.length > 0 ? path : ".";
  return new Promise((resolve, reject) => {
    s.sftp.realpath(target, (rpErr, abs) => {
      const resolved = rpErr ? target : abs;
      s.sftp.readdir(resolved, (err, listRaw) => {
        if (err) {
          reject(new Error(`Cannot read ${resolved}: ${err.message}`));
          return;
        }
        const entries: RemoteEntry[] = listRaw.map((e) => {
          const attrs = e.attrs;
          return {
            name: e.filename,
            kind: entryKind(e.longname, attrs),
            sizeBytes: typeof attrs.size === "number" ? attrs.size : 0,
            modifiedMs: typeof attrs.mtime === "number" ? attrs.mtime * 1000 : 0,
            mode: typeof attrs.mode === "number" ? attrs.mode & 0o7777 : null,
          };
        });
        entries.sort((a, b) => {
          const ad = a.kind === "directory" ? 0 : 1;
          const bd = b.kind === "directory" ? 0 : 1;
          return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
        });
        resolve({ path: resolved, entries });
      });
    });
  });
}
