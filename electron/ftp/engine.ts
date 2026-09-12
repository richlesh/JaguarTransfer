// FTP / FTPS engine (Electron main process). Implements RemoteBackend over
// `basic-ftp` (CommonJS). FTP allows only ONE operation per control connection,
// so each session keeps a small POOL of clients and hands one to each concurrent
// operation. Supports explicit/implicit FTPS and (discouraged) plain FTP.
//
// Notes vs. SFTP/WebDAV:
//  - Security is TLS-based (FTPS) or none (plain FTP). No SSH host-key TOFU.
//  - basic-ftp transfers are Promise-based, not Node streams, and have no
//    mid-transfer pause — so pause is unsupported (capabilities.pausable=false).
//    cancel() closes the client to abort; resume-from-partial uses downloadTo's
//    startAt (download) and appendFrom's localStart (upload).
//  - No server-side hashing → no checksum verification.

import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client, type FileInfo } from "basic-ftp";
import type { Site, RemoteEntry, RemoteListing } from "../../src/shared/types.js";
import type { RemoteBackend, RemoteChild, TransferControl, EngineConnectResult } from "../backend/types.js";
import { getSecret } from "../secrets.js";

/** Max concurrent FTP control connections per session (matches the transfer
 *  manager's default file concurrency). Kept modest to respect per-user
 *  connection limits some servers enforce. */
const POOL_SIZE = 4;
/** basic-ftp control timeout (ms). */
const FTP_TIMEOUT = 30000;

interface Pooled {
  client: Client;
  busy: boolean;
}

interface Session {
  id: string;
  site: Site;
  pool: Pooled[];
  /** FIFO of waiters queued for a free client. */
  waiters: Array<(c: Pooled) => void>;
  closed: boolean;
}

const sessions = new Map<string, Session>();

function sessionOrThrow(sessionId: string): Session {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("Not connected (unknown session).");
  return s;
}

/** Build access options for basic-ftp from a site + its stored secret. */
function accessOptions(site: Site): Parameters<Client["access"]>[0] {
  const security = site.ftpSecurity ?? "explicit";
  const defaultPort = security === "implicit" ? 990 : 21;
  return {
    host: site.host,
    port: site.port || defaultPort,
    user: site.username || "anonymous",
    password: getSecret(site.id) ?? "",
    secure: security === "none" ? false : security === "implicit" ? "implicit" : true,
    // Accept the server's certificate chain as-is (self-signed FTPS is common);
    // rejectUnauthorized:false trades strict PKI for broad compatibility.
    secureOptions: { rejectUnauthorized: false },
  };
}

/** Create + connect a fresh pooled client for a session. */
async function openClient(site: Site): Promise<Pooled> {
  const client = new Client(FTP_TIMEOUT);
  await client.access(accessOptions(site));
  return { client, busy: false };
}

/** Acquire a client from the pool: reuse a free one, grow the pool up to
 *  POOL_SIZE, or wait for one to be released. */
async function acquire(s: Session): Promise<Pooled> {
  if (s.closed) throw new Error("Not connected (session closed).");
  const free = s.pool.find((p) => !p.busy);
  if (free) {
    free.busy = true;
    return free;
  }
  if (s.pool.length < POOL_SIZE) {
    const p = await openClient(s.site);
    p.busy = true;
    s.pool.push(p);
    return p;
  }
  // Pool exhausted — wait for a release.
  return new Promise<Pooled>((resolve) => s.waiters.push(resolve));
}

/** Return a client to the pool, handing it to the next waiter if any. Clients
 *  that errored/closed are replaced lazily on next acquire. */
function release(s: Session, p: Pooled): void {
  const next = s.waiters.shift();
  if (next) {
    // Keep it busy and hand straight to the waiter.
    next(p);
    return;
  }
  p.busy = false;
}

/** Run an operation with a pooled client, always releasing it afterward. If the
 *  client is closed by the operation (e.g. cancel), drop it from the pool. */
async function withClient<T>(sessionId: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const s = sessionOrThrow(sessionId);
  const p = await acquire(s);
  try {
    return await fn(p.client);
  } finally {
    if (p.client.closed) {
      // Remove the dead client; open a replacement lazily later.
      const idx = s.pool.indexOf(p);
      if (idx >= 0) s.pool.splice(idx, 1);
      // Still satisfy a waiter with a fresh client if someone is queued.
      const next = s.waiters.shift();
      if (next && !s.closed) {
        void openClient(s.site)
          .then((np) => {
            np.busy = true;
            s.pool.push(np);
            next(np);
          })
          .catch(() => {
            /* waiter will error on use */
          });
      }
    } else {
      release(s, p);
    }
  }
}

function toEntry(info: FileInfo): RemoteEntry {
  // basic-ftp FileInfo.type: 0=Unknown,1=File,2=Directory,3=SymbolicLink
  const kind: RemoteEntry["kind"] =
    info.isDirectory ? "directory" : info.isSymbolicLink ? "symlink" : "file";
  return {
    name: info.name,
    kind,
    sizeBytes: typeof info.size === "number" ? info.size : 0,
    modifiedMs: info.modifiedAt ? info.modifiedAt.getTime() : 0,
    mode: null,
  };
}

/** POSIX-join a directory path with a child segment. */
function joinPosix(dir: string, child: string): string {
  return (dir.replace(/\/+$/, "") || "") + "/" + child;
}

function dirnamePosix(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

async function connect(site: Site): Promise<EngineConnectResult> {
  const id = randomUUID();
  const session: Session = { id, site, pool: [], waiters: [], closed: false };
  try {
    // Open one client up front to validate host/TLS/credentials.
    const first = await openClient(site);
    session.pool.push(first);
  } catch (e) {
    return { ok: false, error: `Could not connect to the FTP server: ${e instanceof Error ? e.message : String(e)}` };
  }
  sessions.set(id, session);
  let cwd = site.startDir?.trim() || "/";
  try {
    if (site.startDir?.trim()) {
      await withClient(id, (c) => c.cd(site.startDir!.trim()));
    }
    cwd = await withClient(id, (c) => c.pwd());
  } catch {
    cwd = site.startDir?.trim() || "/";
  }
  return { ok: true, sessionId: id, cwd };
}

function disconnect(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.closed = true;
  for (const p of s.pool) {
    try { p.client.close(); } catch { /* noop */ }
  }
  s.pool = [];
  s.waiters = [];
  sessions.delete(sessionId);
}

async function list(sessionId: string, path: string): Promise<RemoteListing> {
  const target = path && path.length > 0 ? path : "/";
  const infos = await withClient(sessionId, (c) => c.list(target));
  const entries: RemoteEntry[] = infos.map(toEntry);
  entries.sort((a, b) => {
    const ad = a.kind === "directory" ? 0 : 1;
    const bd = b.kind === "directory" ? 0 : 1;
    return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
  });
  return { path: target, entries };
}

async function rename(sessionId: string, fromPath: string, toName: string): Promise<void> {
  const to = toName.startsWith("/") ? toName : joinPosix(dirnamePosix(fromPath), toName);
  await withClient(sessionId, (c) => c.rename(fromPath, to));
}

async function mkdir(sessionId: string, parentPath: string, name: string): Promise<void> {
  const dir = joinPosix(parentPath, name);
  // ensureDir creates intermediate dirs and changes cwd; use a dedicated client
  // and restore cwd afterward so it doesn't affect other pooled operations.
  await withClient(sessionId, async (c) => {
    await c.ensureDir(dir);
    await c.cd("/");
  });
}

async function remove(sessionId: string, path: string): Promise<void> {
  if (path === "/" || path === "") throw new Error("Refusing to delete the remote root.");
  await withClient(sessionId, async (c) => {
    // Try file removal first; if it's a directory, remove recursively.
    try {
      await c.remove(path);
    } catch {
      await c.removeDir(path);
    }
  });
}

async function readdirDetailed(sessionId: string, path: string): Promise<RemoteChild[]> {
  const infos = await withClient(sessionId, (c) => c.list(path));
  return infos.map((info) => ({
    name: info.name,
    isDirectory: info.isDirectory,
    isSymlink: info.isSymbolicLink,
    sizeBytes: typeof info.size === "number" ? info.size : 0,
  }));
}

async function ensureRemoteDir(sessionId: string, dir: string): Promise<void> {
  if (!dir || dir === "/" || dir === ".") return;
  await withClient(sessionId, async (c) => {
    await c.ensureDir(dir);
    await c.cd("/");
  });
}

async function remoteSize(sessionId: string, path: string): Promise<number> {
  try {
    return await withClient(sessionId, (c) => c.size(path));
  } catch {
    return -1;
  }
}

/** Adapt a basic-ftp promise-based transfer to TransferControl. Pause is not
 *  supported (no-op); cancel closes the client to abort the in-flight transfer;
 *  progress is reported via trackProgress on the dedicated pooled client. */
function runTransfer(
  sessionId: string,
  onBytes: (transferred: number) => void,
  startOffset: number,
  transfer: (client: Client) => Promise<unknown>
): TransferControl {
  let canceledClient: Client | null = null;
  let canceled = false;

  const done = new Promise<"completed" | "canceled">((resolve, reject) => {
    void withClient(sessionId, async (client) => {
      if (canceled) {
        try { client.close(); } catch { /* noop */ }
        return;
      }
      canceledClient = client;
      client.trackProgress((info) => onBytes(startOffset + info.bytes));
      try {
        await transfer(client);
        client.trackProgress(); // stop reporting
        resolve("completed");
      } catch (e) {
        client.trackProgress();
        if (canceled || client.closed) {
          resolve("canceled");
        } else {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }
    }).catch((e) => {
      if (canceled) resolve("canceled");
      else reject(e instanceof Error ? e : new Error(String(e)));
    });
  });

  return {
    done,
    pause: () => {
      /* FTP has no mid-transfer pause; no-op (UI disables the control). */
    },
    resume: () => {
      /* no-op */
    },
    cancel: () => {
      canceled = true;
      // Closing the client aborts the active data transfer.
      try { canceledClient?.close(); } catch { /* noop */ }
    },
  };
}

function downloadFile(
  sessionId: string,
  remotePath: string,
  localPath: string,
  onBytes: (transferred: number) => void,
  startOffset = 0
): TransferControl {
  return runTransfer(sessionId, onBytes, startOffset, async (client) => {
    // Resume: append to the local file and tell the server to start at offset.
    const write = createWriteStream(localPath, startOffset > 0 ? { flags: "a" } : {});
    await client.downloadTo(write, remotePath, startOffset);
  });
}

function uploadFile(
  sessionId: string,
  localPath: string,
  remotePath: string,
  onBytes: (transferred: number) => void,
  startOffset = 0
): TransferControl {
  return runTransfer(sessionId, onBytes, startOffset, async (client) => {
    if (startOffset > 0) {
      // Resume: append the local file from the offset onto the partial remote.
      await client.appendFrom(localPath, remotePath, { localStart: startOffset });
    } else {
      await client.uploadFrom(localPath, remotePath);
    }
  });
}

export const ftpBackend: RemoteBackend = {
  capabilities: {
    resumeDownload: true, // optimistic (REST); a failed resume surfaces as a task error
    resumeUpload: true, // optimistic (APPE)
    checksum: false, // no server-side hashing
    hostKeyTofu: false, // TLS/PKI (FTPS) or none (plain FTP)
    pausable: false, // basic-ftp has no mid-transfer pause
  },
  connect,
  disconnect,
  list,
  rename,
  mkdir,
  remove,
  readdirDetailed,
  ensureRemoteDir,
  remoteSize,
  downloadFile,
  uploadFile,
  // no remoteSha256 — checksum capability is false
};
