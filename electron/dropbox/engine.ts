// Dropbox engine (Electron main process). Implements RemoteBackend over the
// Dropbox HTTP API v2, authenticating with an OAuth access token that is
// transparently refreshed (see oauth/tokens.ts). Sessions are keyed by an opaque
// id; the site id (needed for token lookup) is carried on the session.
//
// Dropbox specifics:
//  - Root path is "" (empty), subpaths are "/a/b". We normalize the app's "/".
//  - list_folder is paged via list_folder/continue.
//  - download supports HTTP Range (resume); upload uses a single request up to
//    ~150 MB, else upload_session/{start,append_v2,finish} in chunks.
//  - No server-side hash we use for verification; no host-key TOFU. Streamed, so
//    transfers are pausable.

import { createWriteStream, createReadStream, promises as fsp } from "node:fs";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { Site, RemoteEntry, RemoteListing } from "../../src/shared/types.js";
import type { RemoteBackend, RemoteChild, TransferControl, EngineConnectResult } from "../backend/types.js";
import { DROPBOX_PROVIDER, isProviderConfigured } from "../oauth/provider.js";
import { getValidAccessToken, hasTokens } from "../oauth/tokens.js";
import { pipeStreams } from "../sftp/engine.js";

const RPC = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";
/** Dropbox single-request upload limit is 150 MB; use sessions above this. */
const UPLOAD_SESSION_THRESHOLD = 140 * 1024 * 1024;
/** Chunk size for upload sessions and stream buffering. */
const CHUNK_SIZE = 8 * 1024 * 1024;

interface Session {
  id: string;
  siteId: string;
}
const sessions = new Map<string, Session>();

function sessionOrThrow(sessionId: string): Session {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("Not connected (unknown session).");
  return s;
}

/** Normalize an app path to a Dropbox path: root "/" (or "") becomes "". */
function dbxPath(p: string): string {
  if (!p || p === "/" || p === ".") return "";
  let out = p.startsWith("/") ? p : "/" + p;
  out = out.replace(/\/+$/, ""); // no trailing slash
  return out;
}

/** POSIX join for building child paths. */
function joinPosix(dir: string, child: string): string {
  return (dir.replace(/\/+$/, "") || "") + "/" + child;
}
function dirnamePosix(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i);
}

/** Bearer token for a session (refreshes transparently). */
async function authHeader(sessionId: string): Promise<string> {
  const s = sessionOrThrow(sessionId);
  const token = await getValidAccessToken(DROPBOX_PROVIDER, s.siteId);
  return `Bearer ${token}`;
}

/** A Dropbox metadata entry (subset we use). */
interface DbxEntry {
  ".tag": "file" | "folder" | "deleted";
  name: string;
  path_lower?: string;
  path_display?: string;
  size?: number;
  server_modified?: string;
}

/** Call a Dropbox RPC endpoint with a JSON body; returns parsed JSON. */
async function rpc<T>(sessionId: string, path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${RPC}${path}`, {
    method: "POST",
    headers: {
      Authorization: await authHeader(sessionId),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? null),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    if (/missing_scope/.test(text)) {
      throw new Error(
        "This Dropbox authorization is missing required permissions. Enable all scopes on the " +
          "Dropbox app's Permissions tab (and Submit), then click Reconnect in the site editor."
      );
    }
    throw new Error(`Dropbox ${path} failed (HTTP ${resp.status}): ${text.slice(0, 300)}`);
  }
  return (await resp.json()) as T;
}

function toEntry(e: DbxEntry): RemoteEntry {
  return {
    name: e.name,
    kind: e[".tag"] === "folder" ? "directory" : "file",
    sizeBytes: typeof e.size === "number" ? e.size : 0,
    modifiedMs: e.server_modified ? Date.parse(e.server_modified) || 0 : 0,
    mode: null,
  };
}

async function connect(site: Site): Promise<EngineConnectResult> {
  if (!isProviderConfigured(DROPBOX_PROVIDER)) {
    return { ok: false, error: "Dropbox isn't configured in this build (missing client ID)." };
  }
  if (!hasTokens(site.id)) {
    return { ok: false, error: "Not connected to Dropbox. Use “Connect to Dropbox” in the site editor." };
  }
  const id = randomUUID();
  sessions.set(id, { id, siteId: site.id });
  // Validate the token works by listing the start folder.
  const cwd = site.dropboxStartPath?.trim() || "/";
  try {
    await rpc(id, "/files/list_folder", { path: dbxPath(cwd), limit: 1 });
  } catch (e) {
    sessions.delete(id);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, sessionId: id, cwd };
}

function disconnect(sessionId: string): void {
  sessions.delete(sessionId);
}

interface ListFolderResult {
  entries: DbxEntry[];
  cursor: string;
  has_more: boolean;
}

async function listAll(sessionId: string, path: string): Promise<DbxEntry[]> {
  let res = await rpc<ListFolderResult>(sessionId, "/files/list_folder", { path: dbxPath(path) });
  const all = [...res.entries];
  while (res.has_more) {
    res = await rpc<ListFolderResult>(sessionId, "/files/list_folder/continue", { cursor: res.cursor });
    all.push(...res.entries);
  }
  return all.filter((e) => e[".tag"] !== "deleted");
}

async function list(sessionId: string, path: string): Promise<RemoteListing> {
  const target = path && path.length > 0 ? path : "/";
  const entries = (await listAll(sessionId, target)).map(toEntry);
  entries.sort((a, b) => {
    const ad = a.kind === "directory" ? 0 : 1;
    const bd = b.kind === "directory" ? 0 : 1;
    return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
  });
  return { path: target, entries };
}

async function rename(sessionId: string, fromPath: string, toName: string): Promise<void> {
  const to = toName.startsWith("/") ? toName : joinPosix(dirnamePosix(fromPath), toName);
  await rpc(sessionId, "/files/move_v2", { from_path: dbxPath(fromPath), to_path: dbxPath(to) });
}

async function mkdir(sessionId: string, parentPath: string, name: string): Promise<void> {
  await rpc(sessionId, "/files/create_folder_v2", { path: dbxPath(joinPosix(parentPath, name)) });
}

async function remove(sessionId: string, path: string): Promise<void> {
  if (path === "/" || path === "") throw new Error("Refusing to delete the account root.");
  await rpc(sessionId, "/files/delete_v2", { path: dbxPath(path) });
}

async function readdirDetailed(sessionId: string, path: string): Promise<RemoteChild[]> {
  const entries = await listAll(sessionId, path);
  return entries.map((e) => ({
    name: e.name,
    isDirectory: e[".tag"] === "folder",
    isSymlink: false, // Dropbox has no symlinks
    sizeBytes: typeof e.size === "number" ? e.size : 0,
  }));
}

async function ensureRemoteDir(sessionId: string, dir: string): Promise<void> {
  const target = dbxPath(dir);
  if (!target) return; // root always exists
  try {
    await rpc(sessionId, "/files/create_folder_v2", { path: target });
  } catch {
    // Already-exists (conflict) is fine; other errors surface on upload.
  }
}

async function remoteSize(sessionId: string, path: string): Promise<number> {
  try {
    const meta = await rpc<DbxEntry>(sessionId, "/files/get_metadata", { path: dbxPath(path) });
    return typeof meta.size === "number" ? meta.size : 0;
  } catch {
    return -1; // not found
  }
}

/** Fetch the connected account's display label (name / email). */
export async function accountLabel(sessionId: string): Promise<string | null> {
  try {
    const acct = await rpc<{ name?: { display_name?: string }; email?: string }>(
      sessionId,
      "/users/get_current_account",
      null
    );
    return acct.name?.display_name || acct.email || null;
  } catch {
    return null;
  }
}

// ---- Transfers ----

function downloadFile(
  sessionId: string,
  remotePath: string,
  localPath: string,
  onBytes: (transferred: number) => void,
  startOffset = 0
): TransferControl {
  const write = createWriteStream(localPath, startOffset > 0 ? { flags: "a" } : {});
  // Adapt the async fetch + stream into a TransferControl using pipeStreams once
  // the response body is available. We wrap in a small controller so cancel works
  // even before the response arrives.
  let piped: TransferControl | null = null;
  let canceled = false;

  const done = new Promise<"completed" | "canceled">((resolve, reject) => {
    (async () => {
      try {
        const arg = { path: dbxPath(remotePath) };
        const headers: Record<string, string> = {
          Authorization: await authHeader(sessionId),
          "Dropbox-API-Arg": JSON.stringify(arg),
        };
        if (startOffset > 0) headers["Range"] = `bytes=${startOffset}-`;
        const resp = await fetch(`${CONTENT}/files/download`, { method: "POST", headers });
        if (!resp.ok || !resp.body) {
          const text = await resp.text().catch(() => "");
          throw new Error(`Dropbox download failed (HTTP ${resp.status}): ${text.slice(0, 200)}`);
        }
        if (canceled) {
          resolve("canceled");
          return;
        }
        const read = Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0]);
        piped = pipeStreams(read, write, onBytes, startOffset);
        const r = await piped.done;
        resolve(r);
      } catch (e) {
        if (canceled) resolve("canceled");
        else reject(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  });

  return {
    done,
    pause: () => piped?.pause(),
    resume: () => piped?.resume(),
    cancel: () => {
      canceled = true;
      piped?.cancel();
    },
  };
}

function uploadFile(
  sessionId: string,
  localPath: string,
  remotePath: string,
  onBytes: (transferred: number) => void,
  _startOffset = 0
): TransferControl {
  void _startOffset; // Dropbox uploads restart from 0 (no partial-append across sessions)
  let canceled = false;

  const done = new Promise<"completed" | "canceled">((resolve, reject) => {
    (async () => {
      try {
        const size = (await fsp.stat(localPath)).size;
        if (canceled) return resolve("canceled");
        if (size <= UPLOAD_SESSION_THRESHOLD) {
          await uploadSmall(sessionId, localPath, remotePath, size, onBytes, () => canceled);
        } else {
          await uploadSession(sessionId, localPath, remotePath, onBytes, () => canceled);
        }
        resolve(canceled ? "canceled" : "completed");
      } catch (e) {
        if (canceled) resolve("canceled");
        else reject(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  });

  return {
    done,
    pause: () => {
      /* Dropbox upload has no mid-flight pause; treated as non-pausable overall. */
    },
    resume: () => {},
    cancel: () => {
      canceled = true;
    },
  };
}

/** Single-request upload for files up to the session threshold. */
async function uploadSmall(
  sessionId: string,
  localPath: string,
  remotePath: string,
  size: number,
  onBytes: (n: number) => void,
  isCanceled: () => boolean
): Promise<void> {
  const data = await fsp.readFile(localPath);
  if (isCanceled()) return;
  const resp = await fetch(`${CONTENT}/files/upload`, {
    method: "POST",
    headers: {
      Authorization: await authHeader(sessionId),
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ path: dbxPath(remotePath), mode: "overwrite", mute: true }),
    },
    body: data,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Dropbox upload failed (HTTP ${resp.status}): ${text.slice(0, 200)}`);
  }
  onBytes(size);
}

interface SessionStartResult { session_id: string; }

/** Chunked upload session for large files. */
async function uploadSession(
  sessionId: string,
  localPath: string,
  remotePath: string,
  onBytes: (n: number) => void,
  isCanceled: () => boolean
): Promise<void> {
  const start = await fetch(`${CONTENT}/files/upload_session/start`, {
    method: "POST",
    headers: {
      Authorization: await authHeader(sessionId),
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ close: false }),
    },
    body: Buffer.alloc(0),
  });
  if (!start.ok) throw new Error(`Dropbox upload_session/start failed (HTTP ${start.status}).`);
  const { session_id } = (await start.json()) as SessionStartResult;

  let offset = 0;
  const stream = createReadStream(localPath, { highWaterMark: CHUNK_SIZE });
  for await (const chunk of stream) {
    if (isCanceled()) { stream.destroy(); return; }
    const buf = chunk as Buffer;
    const resp = await fetch(`${CONTENT}/files/upload_session/append_v2`, {
      method: "POST",
      headers: {
        Authorization: await authHeader(sessionId),
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify({ cursor: { session_id, offset }, close: false }),
      },
      body: buf,
    });
    if (!resp.ok) throw new Error(`Dropbox upload_session/append failed (HTTP ${resp.status}).`);
    offset += buf.length;
    onBytes(offset);
  }
  if (isCanceled()) return;
  const finish = await fetch(`${CONTENT}/files/upload_session/finish`, {
    method: "POST",
    headers: {
      Authorization: await authHeader(sessionId),
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({
        cursor: { session_id, offset },
        commit: { path: dbxPath(remotePath), mode: "overwrite", mute: true },
      }),
    },
    body: Buffer.alloc(0),
  });
  if (!finish.ok) throw new Error(`Dropbox upload_session/finish failed (HTTP ${finish.status}).`);
}

export const dropboxBackend: RemoteBackend = {
  capabilities: {
    resumeDownload: true, // via HTTP Range
    resumeUpload: false, // upload sessions aren't resumed across app runs
    checksum: false,
    hostKeyTofu: false,
    pausable: true, // downloads stream via pipeStreams; uploads no-op pause
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
};
