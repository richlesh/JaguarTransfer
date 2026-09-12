// WebDAV engine (Electron main process). Implements RemoteBackend over the
// `webdav` client (v5, ESM). One client per session, keyed by an opaque id, so
// the registry/manager can drive it exactly like the SFTP backend.
//
// Notes vs. SFTP:
//  - Auth is TLS/PKI-based (Basic or Bearer token). No SSH host-key TOFU.
//  - Paths are POSIX and relative to the site's baseUrl collection.
//  - Download resume uses HTTP Range; WebDAV PUT has no portable append, so
//    uploads always start from 0 (capabilities.resumeUpload = false).
//  - No server-side hashing → no checksum verification (capabilities.checksum = false).

import { createReadStream, createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import type { WebDAVClient, FileStat } from "webdav";
import type { Site, RemoteEntry, RemoteListing } from "../../src/shared/types.js";
import type { RemoteBackend, RemoteChild, TransferControl, EngineConnectResult } from "../backend/types.js";
import { getSecret } from "../secrets.js";
import { pipeStreams } from "../sftp/engine.js";

/** `webdav` v5 is ESM-only, but the Electron main is compiled to CommonJS.
 *  A static `require("webdav")` throws ERR_REQUIRE_ESM. Even a TS `import()`
 *  gets downleveled to `require()` under module:CommonJS, so we route through a
 *  Function-wrapped `import` that TypeScript won't rewrite — giving us the
 *  runtime's native dynamic import (proper CJS→ESM interop). Cached after first load. */
type WebdavModule = typeof import("webdav");
const nativeImport = new Function("specifier", "return import(specifier);") as (
  specifier: string
) => Promise<unknown>;
let webdavModPromise: Promise<WebdavModule> | null = null;
function loadWebdav(): Promise<WebdavModule> {
  if (!webdavModPromise) webdavModPromise = nativeImport("webdav") as Promise<WebdavModule>;
  return webdavModPromise;
}

/** Read/stream buffer size per chunk (matches the SFTP engine). */
const CHUNK_SIZE = 32 * 1024;

interface Session {
  id: string;
  site: Site;
  client: WebDAVClient;
}

const sessions = new Map<string, Session>();

function sessionOrThrow(sessionId: string): Session {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("Not connected (unknown session).");
  return s;
}

/** POSIX-join a directory path with a child segment. */
function joinPosix(dir: string, child: string): string {
  return (dir.replace(/\/+$/, "") || "") + "/" + child;
}

/** POSIX dirname. */
function dirnamePosix(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

/** Normalize a WebDAV path: ensure a leading slash, collapse duplicate slashes. */
function normalizePath(p: string): string {
  const withLead = p.startsWith("/") ? p : "/" + p;
  return withLead.replace(/\/{2,}/g, "/");
}

/** Map a webdav FileStat to our FsEntry (WebDAV has no symlinks or POSIX mode). */
function toEntry(stat: FileStat): RemoteEntry {
  return {
    name: stat.basename,
    kind: stat.type === "directory" ? "directory" : "file",
    sizeBytes: typeof stat.size === "number" ? stat.size : 0,
    modifiedMs: stat.lastmod ? Date.parse(stat.lastmod) || 0 : 0,
    mode: null,
  };
}

/** Build a webdav client for a site from its stored secret. */
async function clientForSite(site: Site): Promise<WebDAVClient> {
  const { createClient, AuthType } = await loadWebdav();
  const baseUrl = (site.baseUrl ?? "").trim();
  if (!baseUrl) throw new Error("WebDAV site is missing its URL.");
  const auth = site.webdavAuth ?? "basic";
  const secret = getSecret(site.id) ?? "";
  if (auth === "bearer") {
    return createClient(baseUrl, {
      authType: AuthType.Token,
      token: { access_token: secret, token_type: "Bearer" },
    });
  }
  if (auth === "none") {
    return createClient(baseUrl, { authType: AuthType.None });
  }
  // basic
  return createClient(baseUrl, {
    authType: AuthType.Password,
    username: site.username,
    password: secret,
  });
}

async function connect(site: Site): Promise<EngineConnectResult> {
  let client: WebDAVClient;
  try {
    client = await clientForSite(site);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const start = normalizePath(site.startDir?.trim() || "/");
  try {
    // Verify connectivity + auth by listing the start directory. This surfaces
    // TLS, DNS, 401/403 and 404 errors up front with a clear message.
    await client.getDirectoryContents(start);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Could not connect to the WebDAV server: ${msg}` };
  }
  const id = randomUUID();
  sessions.set(id, { id, site, client });
  return { ok: true, sessionId: id, cwd: start };
}

function disconnect(sessionId: string): void {
  // WebDAV is stateless HTTP; just drop the client reference.
  sessions.delete(sessionId);
}

/** getDirectoryContents can return a bare array or a detailed wrapper; unwrap. */
function asStatArray(res: FileStat[] | { data: FileStat[] }): FileStat[] {
  return Array.isArray(res) ? res : res.data;
}

async function list(sessionId: string, path: string): Promise<RemoteListing> {
  const s = sessionOrThrow(sessionId);
  const target = normalizePath(path && path.length > 0 ? path : "/");
  const contents = asStatArray(await s.client.getDirectoryContents(target));
  const entries: RemoteEntry[] = contents.map(toEntry);
  entries.sort((a, b) => {
    const ad = a.kind === "directory" ? 0 : 1;
    const bd = b.kind === "directory" ? 0 : 1;
    return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
  });
  return { path: target, entries };
}

async function rename(sessionId: string, fromPath: string, toName: string): Promise<void> {
  const s = sessionOrThrow(sessionId);
  const to = toName.startsWith("/") ? toName : joinPosix(dirnamePosix(fromPath), toName);
  await s.client.moveFile(normalizePath(fromPath), normalizePath(to));
}

async function mkdir(sessionId: string, parentPath: string, name: string): Promise<void> {
  const s = sessionOrThrow(sessionId);
  await s.client.createDirectory(normalizePath(joinPosix(parentPath, name)));
}

async function remove(sessionId: string, path: string): Promise<void> {
  const s = sessionOrThrow(sessionId);
  if (path === "/" || path === "") throw new Error("Refusing to delete the remote root.");
  // WebDAV DELETE on a collection removes it recursively, server-side.
  await s.client.deleteFile(normalizePath(path));
}

async function readdirDetailed(sessionId: string, path: string): Promise<RemoteChild[]> {
  const s = sessionOrThrow(sessionId);
  const contents = asStatArray(await s.client.getDirectoryContents(normalizePath(path)));
  return contents.map((stat) => ({
    name: stat.basename,
    isDirectory: stat.type === "directory",
    isSymlink: false, // WebDAV has no symlinks
    sizeBytes: typeof stat.size === "number" ? stat.size : 0,
  }));
}

async function ensureRemoteDir(sessionId: string, dir: string): Promise<void> {
  const s = sessionOrThrow(sessionId);
  const target = normalizePath(dir);
  if (target === "/") return;
  // The webdav client can create intermediate directories in one call.
  try {
    await s.client.createDirectory(target, { recursive: true });
  } catch {
    // Ignore "already exists"; a genuine failure surfaces on the write.
  }
}

async function remoteSize(sessionId: string, path: string): Promise<number> {
  const s = sessionOrThrow(sessionId);
  try {
    const stat = await s.client.stat(normalizePath(path));
    const data = "data" in stat ? stat.data : stat;
    return typeof data.size === "number" ? data.size : 0;
  } catch {
    return -1; // treat "not found" (and other stat errors) as absent
  }
}

function downloadFile(
  sessionId: string,
  remotePath: string,
  localPath: string,
  onBytes: (transferred: number) => void,
  startOffset = 0
): TransferControl {
  const s = sessionOrThrow(sessionId);
  const read = s.client.createReadStream(
    normalizePath(remotePath),
    startOffset > 0 ? { range: { start: startOffset } } : {}
  );
  const write = createWriteStream(localPath, startOffset > 0 ? { flags: "a" } : {});
  return pipeStreams(read as NodeJS.ReadableStream & { pause(): void; resume(): void }, write, onBytes, startOffset);
}

function uploadFile(
  sessionId: string,
  localPath: string,
  remotePath: string,
  onBytes: (transferred: number) => void,
  startOffset = 0
): TransferControl {
  const s = sessionOrThrow(sessionId);
  // WebDAV PUT has no portable append/partial upload, so uploads always start
  // from the beginning regardless of any requested offset.
  void startOffset;
  const read = createReadStream(localPath, { highWaterMark: CHUNK_SIZE });
  const write = s.client.createWriteStream(normalizePath(remotePath), { overwrite: true });
  return pipeStreams(read, write as NodeJS.WritableStream & { end(): void }, onBytes, 0);
}

export const webdavBackend: RemoteBackend = {
  capabilities: {
    resumeDownload: true, // via HTTP Range
    resumeUpload: false, // PUT has no portable append
    checksum: false, // no server-side hashing
    hostKeyTofu: false, // TLS/PKI, not SSH TOFU
    pausable: true, // streamed via pipeStreams, so pause works
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
