// SFTP engine (Electron main process). Wraps ssh2 to: open one persistent SSH
// connection per session, verify the host key against our TOFU store, and read
// remote directories. Transfers (chunked/pipelined) come in M3.

import { readFileSync, createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { Client } from "ssh2";
import type { SFTPWrapper, ConnectConfig } from "ssh2";
import type { Site, RemoteEntry, RemoteListing, HostKeyPrompt } from "../../src/shared/types.js";
import { verifyHostKey } from "../knownHosts.js";
import { getSecret, jumpAccount } from "../secrets.js";

interface Session {
  id: string;
  site: Site;
  client: Client;
  sftp: SFTPWrapper;
  /** The bastion client when connected through a jump host (closed on disconnect). */
  bastion?: Client;
  /** Set when the user explicitly disconnected — suppresses auto-reconnect. */
  userClosed: boolean;
  /** True while a reconnect loop is running. */
  reconnecting: boolean;
}

const sessions = new Map<string, Session>();

import type { ConnectionStateEvent } from "../../src/shared/types.js";

let onConnState: (e: ConnectionStateEvent) => void = () => {};
/** Register a listener for connection-state changes (wired to webContents.send). */
export function onConnectionState(cb: (e: ConnectionStateEvent) => void): void {
  onConnState = cb;
}

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
/**
 * Build the ssh2 auth part of a connect config for the given auth method, key
 * path, and keychain account (the account under which the secret is stored).
 * Works for both the target site and a jump host (bastion).
 */
function buildAuthFor(
  authMethod: Site["authMethod"],
  privateKeyPath: string | undefined,
  secretAccount: string
): Partial<ConnectConfig> {
  const secret = getSecret(secretAccount) ?? undefined;
  if (authMethod === "agent") {
    const agent = process.env.SSH_AUTH_SOCK || (process.platform === "win32" ? "pageant" : undefined);
    return { agent, agentForward: false };
  }
  if (authMethod === "key") {
    if (!privateKeyPath) throw new Error("Key auth selected but no private key path was provided.");
    const privateKey = readFileSync(expandHome(privateKeyPath));
    return secret ? { privateKey, passphrase: secret } : { privateKey };
  }
  return { password: secret };
}

/** Auth config for the target site (secret stored under the site id). */
function buildAuth(site: Site): Partial<ConnectConfig> {
  return buildAuthFor(site.authMethod, site.privateKeyPath, site.id);
}

/** Result of dialing a bastion: a tunneled socket to the target, plus the
 *  bastion client (to close on disconnect), OR a host-key prompt / error. */
type BastionDial =
  | { ok: true; sock: import("ssh2").ClientChannel; bastion: Client }
  | { ok: false; needsHostKeyTrust: true; prompt: HostKeyPrompt }
  | { ok: false; error: string };

/**
 * Connect to the jump host and open a forwarded channel to the target host:port.
 * The returned `sock` is handed to the target ssh2 client as its transport, so
 * the SSH session runs end-to-end through the bastion. Verifies the bastion's
 * host key via TOFU (prompting for its own host:port when untrusted).
 */
function dialBastion(site: Site): Promise<BastionDial> {
  const jump = site.jump!;
  return new Promise((resolve) => {
    const bastion = new Client();
    let settled = false;
    let pendingPrompt: HostKeyPrompt | null = null;
    const done = (r: BastionDial) => {
      if (settled) return;
      settled = true;
      if (!r.ok) { try { bastion.end(); } catch { /* noop */ } }
      resolve(r);
    };

    let auth: Partial<ConnectConfig>;
    try {
      auth = buildAuthFor(jump.authMethod, jump.privateKeyPath, jumpAccount(site.id));
    } catch (e) {
      return done({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }

    bastion.on("keyboard-interactive", (_n, _i, _l, _p, cb) => cb([getSecret(jumpAccount(site.id)) ?? ""]));
    bastion.on("ready", () => {
      bastion.forwardOut("127.0.0.1", 0, site.host, site.port || 22, (err, stream) => {
        if (err) return done({ ok: false, error: `Jump host could not reach ${site.host}: ${err.message}` });
        done({ ok: true, sock: stream, bastion });
      });
    });
    bastion.on("error", (err: Error) => {
      if (pendingPrompt) done({ ok: false, needsHostKeyTrust: true, prompt: pendingPrompt });
      else done({ ok: false, error: `Jump host: ${err.message}` });
    });

    try {
      bastion.connect({
        host: jump.host,
        port: jump.port || 22,
        username: jump.username,
        readyTimeout: 20000,
        keepaliveInterval: 15000,
        tryKeyboard: jump.authMethod === "password",
        ...auth,
        hostVerifier: (keyBuf: Buffer) => {
          const fp = fingerprintSha256(keyBuf);
          const status = verifyHostKey(jump.host, jump.port || 22, fp);
          if (status === "trusted") return true;
          pendingPrompt = {
            host: jump.host,
            port: jump.port || 22,
            keyType: detectKeyType(keyBuf),
            fingerprintSha256: fp,
            changed: status === "changed",
          };
          return false;
        },
      });
    } catch (e) {
      done({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

/**
 * Connect to a site. Verifies the host key first (TOFU): if the key is unknown
 * or changed, resolves with needsHostKeyTrust so the UI can prompt; on retry
 * (after trustHostKey) the key will verify and the connection proceeds.
 */
export function connect(site: Site): Promise<EngineConnectResult> {
  return new Promise((resolve) => {
    void (async () => {
      let settled = false;
      const done = (r: EngineConnectResult) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      // If a jump host is enabled, dial it first and tunnel to the target.
      let sock: import("ssh2").ClientChannel | undefined;
      let bastion: Client | undefined;
      if (site.jump?.enabled) {
        const dial = await dialBastion(site);
        if (!dial.ok) return done(dial);
        sock = dial.sock;
        bastion = dial.bastion;
      }

      const client = new Client();
      const auth = (() => {
        try {
          return buildAuth(site);
        } catch (e) {
          return e instanceof Error ? e : new Error(String(e));
        }
      })();
      if (auth instanceof Error) {
        try { bastion?.end(); } catch { /* noop */ }
        return done({ ok: false, error: auth.message });
      }

      let pendingPrompt: HostKeyPrompt | null = null;
      const config: ConnectConfig = {
        host: site.host,
        port: site.port || 22,
        username: site.username,
        readyTimeout: 20000,
        keepaliveInterval: 15000,
        tryKeyboard: site.authMethod === "password",
        ...(sock ? { sock } : {}),
        ...(site.compression ? { algorithms: { compress: ["zlib@openssh.com", "zlib", "none"] } } : {}),
        ...auth,
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
          return false;
        },
      };

      client.on("keyboard-interactive", (_name, _instr, _lang, _prompts, finish) => {
        finish([getSecret(site.id) ?? ""]);
      });

      client.on("ready", () => {
        client.sftp((err, sftp) => {
          if (err) {
            client.end();
            try { bastion?.end(); } catch { /* noop */ }
            done({ ok: false, error: `SFTP subsystem failed: ${err.message}` });
            return;
          }
          const id = randomUUID();
          const session: Session = { id, site, client, sftp, bastion, userClosed: false, reconnecting: false };
          sessions.set(id, session);
          attachDropHandler(session);
          const start = site.startDir?.trim();
          if (start) {
            done({ ok: true, sessionId: id, cwd: start });
          } else {
            sftp.realpath(".", (rpErr, abs) => {
              done({ ok: true, sessionId: id, cwd: rpErr ? "/" : abs });
            });
          }
        });
      });

      client.on("error", (err: Error) => {
        try { bastion?.end(); } catch { /* noop */ }
        if (pendingPrompt) {
          done({ ok: false, needsHostKeyTrust: true, prompt: pendingPrompt });
        } else {
          done({ ok: false, error: err.message });
        }
      });

      try {
        client.connect(config);
      } catch (e) {
        try { bastion?.end(); } catch { /* noop */ }
        done({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
  });
}

/** Build the ssh2 connect config for a site (host key already trusted on
 *  reconnect; hostVerifier just re-confirms the trusted fingerprint). */
function buildConfig(site: Site): ConnectConfig {
  return {
    host: site.host,
    port: site.port || 22,
    username: site.username,
    readyTimeout: 20000,
    keepaliveInterval: 15000,
    tryKeyboard: site.authMethod === "password",
    ...(site.compression ? { algorithms: { compress: ["zlib@openssh.com", "zlib", "none"] } } : {}),
    ...buildAuth(site),
    hostVerifier: (keyBuf: Buffer) =>
      verifyHostKey(site.host, site.port || 22, fingerprintSha256(keyBuf)) === "trusted",
  };
}

/** Attach a one-shot drop handler that triggers auto-reconnect on an unexpected
 *  close/error (not a user disconnect). */
function attachDropHandler(session: Session): void {
  const onDrop = () => {
    if (session.userClosed || session.reconnecting) return;
    if (!sessions.has(session.id)) return;
    void reconnect(session);
  };
  session.client.once("close", onDrop);
  session.client.once("error", onDrop);
}

/** Reconnect a dropped session with exponential backoff, reusing the site + its
 *  trusted host key, and swap in the fresh client/sftp under the same id. */
async function reconnect(session: Session): Promise<void> {
  session.reconnecting = true;
  const delays = [1000, 2000, 4000, 8000, 15000, 15000]; // backoff, capped
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (session.userClosed || !sessions.has(session.id)) {
      session.reconnecting = false;
      return;
    }
    onConnState({ sessionId: session.id, state: "reconnecting", detail: `attempt ${attempt + 1}` });
    await new Promise((r) => setTimeout(r, delays[attempt]));
    if (session.userClosed || !sessions.has(session.id)) {
      session.reconnecting = false;
      return;
    }
    const ok = await tryReestablish(session);
    if (ok) {
      session.reconnecting = false;
      attachDropHandler(session); // re-arm for the next drop
      onConnState({ sessionId: session.id, state: "connected" });
      return;
    }
  }
  // Exhausted attempts: give up and drop the session.
  session.reconnecting = false;
  onConnState({ sessionId: session.id, state: "disconnected", detail: "reconnect failed" });
  sessions.delete(session.id);
}

/** One reconnection attempt: open a fresh client + SFTP and swap into `session`.
 *  Re-dials the bastion first when the site connects through a jump host. */
function tryReestablish(session: Session): Promise<boolean> {
  return new Promise((resolve) => {
    void (async () => {
      let config: ConnectConfig;
      try {
        config = buildConfig(session.site);
      } catch {
        resolve(false);
        return;
      }

      // Re-establish the bastion tunnel first, if used.
      let newBastion: Client | undefined;
      if (session.site.jump?.enabled) {
        const dial = await dialBastion(session.site);
        if (!dial.ok) return resolve(false);
        config = { ...config, sock: dial.sock };
        newBastion = dial.bastion;
      }

      const client = new Client();
      let settled = false;
      const finish = (v: boolean) => {
        if (settled) return;
        settled = true;
        if (!v) { try { newBastion?.end(); } catch { /* noop */ } }
        resolve(v);
      };
      client.on("keyboard-interactive", (_n, _i, _l, _p, cb) => cb([getSecret(session.site.id) ?? ""]));
      client.on("ready", () => {
        client.sftp((err, sftp) => {
          if (err) {
            client.end();
            return finish(false);
          }
          // Swap the live handles under the same session id; close the old bastion.
          try { session.client.removeAllListeners(); } catch { /* noop */ }
          try { session.bastion?.end(); } catch { /* noop */ }
          session.client = client;
          session.sftp = sftp;
          session.bastion = newBastion;
          finish(true);
        });
      });
      client.on("error", () => finish(false));
      try {
        client.connect(config);
      } catch {
        finish(false);
      }
    })();
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
  s.userClosed = true; // suppress auto-reconnect for an intentional disconnect
  try {
    s.client.end();
  } catch {
    // ignore
  }
  try { s.bastion?.end(); } catch { /* noop */ }
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

function sessionOrThrow(sessionId: string): Session {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("Not connected (unknown session).");
  return s;
}

/** POSIX-join a directory path with a child segment. */
function joinRemote(dir: string, child: string): string {
  return dir.replace(/\/+$/, "") + "/" + child;
}

/** Rename/move a remote entry. `toName` may be a bare name (rename within the
 *  same directory) or an absolute path (move). */
export function rename(sessionId: string, fromPath: string, toName: string): Promise<void> {
  const s = sessionOrThrow(sessionId);
  const to = toName.startsWith("/") ? toName : joinRemote(dirnameRemote(fromPath), toName);
  return new Promise((resolve, reject) => {
    s.sftp.rename(fromPath, to, (err) => (err ? reject(new Error(err.message)) : resolve()));
  });
}

/** Create a remote directory under `parentPath`. */
export function mkdir(sessionId: string, parentPath: string, name: string): Promise<void> {
  const s = sessionOrThrow(sessionId);
  const dir = joinRemote(parentPath, name);
  return new Promise((resolve, reject) => {
    s.sftp.mkdir(dir, (err) => (err ? reject(new Error(err.message)) : resolve()));
  });
}

/** POSIX dirname for a remote path. */
function dirnameRemote(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

function statRemote(sftp: SFTPWrapper, path: string): Promise<{ isDir: boolean }> {
  return new Promise((resolve, reject) => {
    sftp.lstat(path, (err, stats) => {
      if (err) reject(new Error(err.message));
      else resolve({ isDir: stats.isDirectory() });
    });
  });
}

function readdirRemote(sftp: SFTPWrapper, path: string): Promise<Array<{ name: string; isDir: boolean }>> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (err, list) => {
      if (err) reject(new Error(err.message));
      else resolve(list.map((e) => ({ name: e.filename, isDir: e.attrs.isDirectory() })));
    });
  });
}

function unlinkRemote(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, (err) => (err ? reject(new Error(err.message)) : resolve()));
  });
}

function rmdirRemote(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rmdir(path, (err) => (err ? reject(new Error(err.message)) : resolve()));
  });
}

/**
 * Delete a remote file or directory. SFTP rmdir is non-recursive, so for a
 * directory we depth-first remove its contents before removing the directory.
 * Symlinks are unlinked (never followed).
 */
export async function remove(sessionId: string, path: string): Promise<void> {
  const s = sessionOrThrow(sessionId);
  if (path === "/" || path === "") throw new Error("Refusing to delete the remote root.");
  const st = await statRemote(s.sftp, path);
  if (!st.isDir) {
    await unlinkRemote(s.sftp, path);
    return;
  }
  const children = await readdirRemote(s.sftp, path);
  for (const c of children) {
    const child = joinRemote(path, c.name);
    if (c.isDir) await remove(sessionId, child);
    else await unlinkRemote(s.sftp, child);
  }
  await rmdirRemote(s.sftp, path);
}


// ---- Transfer primitives (M3) ----
//
// ssh2's fastGet/fastPut perform CONCURRENT, CHUNKED transfers over the single
// SSH connection — i.e. request pipelining (multiple in-flight read/write
// packets), which is exactly what tolerates high-latency links. We expose a
// per-file wrapper with a byte-progress callback plus directory walking and
// remote mkdir -p, so the transfer manager can plan whole trees.

import { promises as fsp } from "node:fs";

/** Read/stream buffer size per chunk. */
const CHUNK_SIZE = 32 * 1024;

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

/** One entry from a remote directory (name + kind + size), for walking trees. */
export interface RemoteChild {
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
  sizeBytes: number;
}

export function readdirDetailed(sessionId: string, path: string): Promise<RemoteChild[]> {
  const s = sessionOrThrow(sessionId);
  return new Promise((resolve, reject) => {
    s.sftp.readdir(path, (err, list) => {
      if (err) return reject(new Error(err.message));
      resolve(
        list.map((e) => ({
          name: e.filename,
          isDirectory: e.attrs.isDirectory(),
          isSymlink: e.attrs.isSymbolicLink(),
          sizeBytes: typeof e.attrs.size === "number" ? e.attrs.size : 0,
        }))
      );
    });
  });
}

/** Ensure a remote directory exists (mkdir -p). Ignores "already exists". */
export async function ensureRemoteDir(sessionId: string, dir: string): Promise<void> {
  const s = sessionOrThrow(sessionId);
  const parts = dir.split("/").filter(Boolean);
  let cur = dir.startsWith("/") ? "" : ".";
  for (const part of parts) {
    cur = cur === "" ? "/" + part : cur + "/" + part;
    await new Promise<void>((resolve) => {
      s.sftp.mkdir(cur, (err) => {
        // EEXIST / failure-because-present is fine; other errors surface on write.
        void err;
        resolve();
      });
    });
  }
}

/** A running transfer that can be paused/resumed/canceled mid-file. */
export interface TransferControl {
  /** Resolves when the file finishes; rejects on error; resolves early if canceled. */
  done: Promise<"completed" | "canceled">;
  pause(): void;
  resume(): void;
  cancel(): void;
}

/** Drive a read→write transfer with progress, pause/resume, and cancel.
 *
 * We do NOT use stream.pipe() because pipe owns flow control and re-resumes the
 * source on every destination 'drain', which defeats a manual pause(). Instead
 * we consume the readable in flowing mode and manage backpressure + pause
 * ourselves, so pause() reliably halts the byte flow until resume(). */
function pipeStreams(
  read: NodeJS.ReadableStream & { destroy?: (e?: Error) => void; pause: () => void; resume: () => void },
  write: NodeJS.WritableStream & { destroy?: (e?: Error) => void; end: () => void },
  onBytes: (transferred: number) => void,
  startOffset = 0
): TransferControl {
  let transferred = startOffset;
  let canceled = false;
  let paused = false;
  let ended = false; // read side reached EOF and we've called write.end()
  let errored = false;
  let settled = false;

  const done = new Promise<"completed" | "canceled">((resolve, reject) => {
    const finish = (r: "completed" | "canceled") => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      errored = true;
      reject(e);
    };

    read.on("data", (chunk: Buffer) => {
      transferred += chunk.length;
      onBytes(transferred);
      const ok = write.write(chunk);
      // Backpressure: pause the source until the destination drains. Don't
      // auto-resume while the user has paused us.
      if (!ok && !canceled) {
        read.pause();
        write.once("drain", () => {
          if (!paused && !canceled) read.resume();
        });
      }
    });
    read.on("end", () => {
      ended = true;
      write.end();
    });
    read.on("error", (e: Error) => {
      if (canceled) return finish("canceled");
      try { write.destroy?.(); } catch { /* noop */ }
      fail(e);
    });
    write.on("error", (e: Error) => {
      if (canceled) return finish("canceled");
      try { read.destroy?.(); } catch { /* noop */ }
      fail(e);
    });
    // A normal completion fires 'finish' (fs writables) OR 'close' (ssh2 SFTP
    // write streams emit 'close', not always 'finish'). Treat either as done,
    // provided the read side ended and there was no error/cancel.
    const onDone = () => {
      if (canceled) return finish("canceled");
      if (errored) return;
      if (ended) finish("completed");
    };
    write.on("finish", onDone);
    write.on("close", onDone);
    read.on("close", () => { if (canceled) finish("canceled"); });
  });

  return {
    done,
    pause: () => {
      paused = true;
      read.pause();
    },
    resume: () => {
      if (!paused || canceled) return;
      paused = false;
      read.resume();
    },
    cancel: () => {
      canceled = true;
      try { read.destroy?.(); } catch { /* noop */ }
      try { write.destroy?.(); } catch { /* noop */ }
    },
  };
}

/** Download one remote file to a local path (abortable/pausable). When
 *  startOffset > 0, resume: read the remote from that offset and append locally. */
export function downloadFile(
  sessionId: string,
  remotePath: string,
  localPath: string,
  onBytes: (transferred: number) => void,
  startOffset = 0
): TransferControl {
  const s = sessionOrThrow(sessionId);
  const read = s.sftp.createReadStream(remotePath, { highWaterMark: CHUNK_SIZE, start: startOffset });
  const write = createWriteStream(localPath, startOffset > 0 ? { flags: "a" } : {});
  return pipeStreams(read, write, onBytes, startOffset);
}

/** Upload one local file to a remote path (abortable/pausable). When
 *  startOffset > 0, resume: read the local file from that offset and append. */
export function uploadFile(
  sessionId: string,
  localPath: string,
  remotePath: string,
  onBytes: (transferred: number) => void,
  startOffset = 0
): TransferControl {
  const s = sessionOrThrow(sessionId);
  const read = createReadStream(localPath, { highWaterMark: CHUNK_SIZE, start: startOffset });
  const write = s.sftp.createWriteStream(remotePath, startOffset > 0 ? { flags: "a" } : {});
  return pipeStreams(read, write, onBytes, startOffset);
}

// (legacy fastGet/fastPut bodies replaced by the stream-based versions above)

/** Size a local path (for planning). */
export async function localSize(path: string): Promise<number> {
  const st = await fsp.lstat(path);
  return Number(st.size) || 0;
}

/** Size of a remote file, or -1 if it doesn't exist (for conflict/resume). */
export function remoteSize(sessionId: string, path: string): Promise<number> {
  const s = sessionOrThrow(sessionId);
  return new Promise((resolve) => {
    s.sftp.stat(path, (err, stats) => {
      if (err || !stats) resolve(-1);
      else resolve(typeof stats.size === "number" ? stats.size : 0);
    });
  });
}

/** Run a command over an SSH exec channel; resolve stdout (trimmed) or reject. */
export function sshExec(sessionId: string, command: string): Promise<string> {
  const s = sessionOrThrow(sessionId);
  return new Promise((resolve, reject) => {
    s.client.exec(command, (err, stream) => {
      if (err) return reject(new Error(err.message));
      let out = "";
      let errOut = "";
      stream.on("data", (d: Buffer) => (out += d.toString()));
      stream.stderr.on("data", (d: Buffer) => (errOut += d.toString()));
      stream.on("close", (code: number) => {
        if (code === 0) resolve(out.trim());
        else reject(new Error(errOut.trim() || `exit ${code}`));
      });
    });
  });
}

/** Best-effort SHA-256 of a remote file via `sha256sum`. Returns the lowercase
 *  hex digest, or null if the command isn't available / fails. */
export async function remoteSha256(sessionId: string, path: string): Promise<string | null> {
  try {
    // Quote the path safely for a POSIX shell.
    const quoted = "'" + path.replace(/'/g, "'\\''") + "'";
    const out = await sshExec(sessionId, `sha256sum ${quoted}`);
    const hex = out.split(/\s+/)[0];
    return /^[0-9a-f]{64}$/i.test(hex) ? hex.toLowerCase() : null;
  } catch {
    return null;
  }
}
