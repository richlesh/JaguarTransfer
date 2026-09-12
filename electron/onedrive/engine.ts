// OneDrive engine (Electron main process). Implements RemoteBackend over the
// Microsoft Graph API, authenticating with an OAuth access token that refreshes
// transparently (oauth/tokens.ts). OneDrive is path-addressable, so this maps
// cleanly onto the app's path-based model.
//
// Graph specifics:
//  - Item by path: /me/drive/root:/{path}   (root is /me/drive/root)
//  - Children:     /me/drive/root:/{path}:/children  (paged via @odata.nextLink)
//  - Download: item /content (supports HTTP Range).
//  - Upload: PUT /content for <4 MB; createUploadSession + chunked PUT otherwise.
//  - No server-side hash we verify against; no host-key TOFU. Streamed downloads
//    are pausable; uploads are chunked without mid-flight pause.

import { createWriteStream, createReadStream, promises as fsp } from "node:fs";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { Site, RemoteEntry, RemoteListing } from "../../src/shared/types.js";
import type { RemoteBackend, RemoteChild, TransferControl, EngineConnectResult } from "../backend/types.js";
import { ONEDRIVE_PROVIDER, isProviderConfigured } from "../oauth/provider.js";
import { getValidAccessToken, hasTokens } from "../oauth/tokens.js";
import { pipeStreams } from "../sftp/engine.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
/** Simple upload limit; above this use an upload session (Graph allows 4 MB). */
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
/** Upload-session chunk size — must be a multiple of 320 KiB per Graph docs. */
const UPLOAD_CHUNK = 5 * 320 * 1024; // 1.6 MB

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

async function bearer(sessionId: string): Promise<string> {
  const s = sessionOrThrow(sessionId);
  return `Bearer ${await getValidAccessToken(ONEDRIVE_PROVIDER, s.siteId)}`;
}

/** Normalize an app path to a clean POSIX path with no leading/trailing slash. */
function cleanPath(p: string): string {
  if (!p || p === "/" || p === ".") return "";
  return p.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** URL-encode each path segment for Graph's /root:/{path}: addressing. */
function encodePath(p: string): string {
  const clean = cleanPath(p);
  if (!clean) return "";
  return clean.split("/").map(encodeURIComponent).join("/");
}

/** Graph item base URL for a path (root when empty). */
function itemUrl(path: string): string {
  const enc = encodePath(path);
  return enc ? `${GRAPH}/me/drive/root:/${enc}` : `${GRAPH}/me/drive/root`;
}

/** Graph children URL for a path (root when empty). */
function childrenUrl(path: string): string {
  const enc = encodePath(path);
  return enc ? `${GRAPH}/me/drive/root:/${enc}:/children` : `${GRAPH}/me/drive/root/children`;
}

/** Graph /content URL for a file path (root-relative). */
function contentUrl(path: string): string {
  const enc = encodePath(path);
  return enc ? `${GRAPH}/me/drive/root:/${enc}:/content` : `${GRAPH}/me/drive/root/content`;
}

function joinPosix(dir: string, child: string): string {
  return (dir.replace(/\/+$/, "") || "") + "/" + child;
}
function dirnamePosix(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i);
}
function basenamePosix(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i < 0 ? t : t.slice(i + 1);
}

/** A Graph driveItem (subset used). */
interface DriveItem {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  folder?: { childCount?: number };
  file?: { mimeType?: string };
  "@microsoft.graph.downloadUrl"?: string;
}

interface GraphError {
  error?: { code?: string; message?: string };
}

/** Perform a Graph request and parse JSON; throws on non-2xx with the Graph message. */
async function graph<T>(sessionId: string, url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, {
    ...init,
    headers: {
      Authorization: await bearer(sessionId),
      ...(init?.body && !(init.headers as Record<string, string>)?.["Content-Type"]
        ? { "Content-Type": "application/json" }
        : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let msg = `HTTP ${resp.status}`;
    try {
      const j = JSON.parse(text) as GraphError;
      if (j.error?.message) msg = j.error.message;
    } catch { /* keep default */ }
    throw new Error(`OneDrive request failed (${msg}).`);
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

function toEntry(it: DriveItem): RemoteEntry {
  return {
    name: it.name,
    kind: it.folder ? "directory" : "file",
    sizeBytes: typeof it.size === "number" ? it.size : 0,
    modifiedMs: it.lastModifiedDateTime ? Date.parse(it.lastModifiedDateTime) || 0 : 0,
    mode: null,
  };
}

interface ChildrenPage {
  value: DriveItem[];
  "@odata.nextLink"?: string;
}

async function listItems(sessionId: string, path: string): Promise<DriveItem[]> {
  const items: DriveItem[] = [];
  let url: string | undefined = `${childrenUrl(path)}?$top=200`;
  while (url) {
    const page: ChildrenPage = await graph<ChildrenPage>(sessionId, url);
    items.push(...page.value);
    url = page["@odata.nextLink"];
  }
  return items;
}

async function connect(site: Site): Promise<EngineConnectResult> {
  if (!isProviderConfigured(ONEDRIVE_PROVIDER)) {
    return { ok: false, error: "OneDrive isn't configured in this build (missing client ID)." };
  }
  if (!hasTokens(site.id)) {
    return { ok: false, error: "Not connected to OneDrive. Use “Connect to OneDrive” in the site editor." };
  }
  const id = randomUUID();
  sessions.set(id, { id, siteId: site.id });
  const cwd = site.onedriveStartPath?.trim() || "/";
  try {
    await listItems(id, cwd); // validate token + path
  } catch (e) {
    sessions.delete(id);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, sessionId: id, cwd };
}

function disconnect(sessionId: string): void {
  sessions.delete(sessionId);
}

async function list(sessionId: string, path: string): Promise<RemoteListing> {
  const target = path && path.length > 0 ? path : "/";
  const entries = (await listItems(sessionId, target)).map(toEntry);
  entries.sort((a, b) => {
    const ad = a.kind === "directory" ? 0 : 1;
    const bd = b.kind === "directory" ? 0 : 1;
    return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
  });
  return { path: target, entries };
}

async function rename(sessionId: string, fromPath: string, toName: string): Promise<void> {
  // Rename within the same folder, or move when an absolute path is given.
  const body: { name?: string; parentReference?: { path: string } } = {};
  if (toName.startsWith("/")) {
    body.name = basenamePosix(toName);
    const parent = dirnamePosix(toName);
    const enc = encodePath(parent);
    body.parentReference = { path: enc ? `/drive/root:/${enc}` : "/drive/root:" };
  } else {
    body.name = toName;
  }
  await graph(sessionId, itemUrl(fromPath), { method: "PATCH", body: JSON.stringify(body) });
}

async function mkdir(sessionId: string, parentPath: string, name: string): Promise<void> {
  await graph(sessionId, childrenUrl(parentPath), {
    method: "POST",
    body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
  });
}

async function remove(sessionId: string, path: string): Promise<void> {
  if (path === "/" || path === "") throw new Error("Refusing to delete the drive root.");
  await graph(sessionId, itemUrl(path), { method: "DELETE" });
}

async function readdirDetailed(sessionId: string, path: string): Promise<RemoteChild[]> {
  const items = await listItems(sessionId, path);
  return items.map((it) => ({
    name: it.name,
    isDirectory: !!it.folder,
    isSymlink: false,
    sizeBytes: typeof it.size === "number" ? it.size : 0,
  }));
}

async function ensureRemoteDir(sessionId: string, dir: string): Promise<void> {
  const clean = cleanPath(dir);
  if (!clean) return;
  // Walk segments, creating each if missing (idempotent via conflictBehavior).
  const parts = clean.split("/");
  let cur = "";
  for (const part of parts) {
    const parent = cur;
    cur = cur ? `${cur}/${part}` : part;
    try {
      await graph(sessionId, childrenUrl(parent), {
        method: "POST",
        body: JSON.stringify({ name: part, folder: {}, "@microsoft.graph.conflictBehavior": "replace" }),
      });
    } catch {
      // Best-effort; if it already exists as a folder this is fine.
    }
  }
}

async function remoteSize(sessionId: string, path: string): Promise<number> {
  try {
    const it = await graph<DriveItem>(sessionId, itemUrl(path));
    return typeof it.size === "number" ? it.size : 0;
  } catch {
    return -1;
  }
}

/** Fetch the signed-in user's label. */
export async function accountLabel(sessionId: string): Promise<string | null> {
  try {
    const me = await graph<{ displayName?: string; userPrincipalName?: string; mail?: string }>(
      sessionId,
      `${GRAPH}/me`
    );
    return me.displayName || me.userPrincipalName || me.mail || null;
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
  let piped: TransferControl | null = null;
  let canceled = false;

  const done = new Promise<"completed" | "canceled">((resolve, reject) => {
    (async () => {
      try {
        const headers: Record<string, string> = { Authorization: await bearer(sessionId) };
        if (startOffset > 0) headers["Range"] = `bytes=${startOffset}-`;
        const resp = await fetch(contentUrl(remotePath), {
          headers,
        });
        if (!resp.ok || !resp.body) {
          const text = await resp.text().catch(() => "");
          throw new Error(`OneDrive download failed (HTTP ${resp.status}): ${text.slice(0, 200)}`);
        }
        if (canceled) return resolve("canceled");
        const read = Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0]);
        piped = pipeStreams(read, write, onBytes, startOffset);
        resolve(await piped.done);
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
    cancel: () => { canceled = true; piped?.cancel(); },
  };
}

function uploadFile(
  sessionId: string,
  localPath: string,
  remotePath: string,
  onBytes: (transferred: number) => void,
  _startOffset = 0
): TransferControl {
  void _startOffset;
  let canceled = false;

  const done = new Promise<"completed" | "canceled">((resolve, reject) => {
    (async () => {
      try {
        const size = (await fsp.stat(localPath)).size;
        if (canceled) return resolve("canceled");
        if (size <= SIMPLE_UPLOAD_MAX) {
          await uploadSimple(sessionId, localPath, remotePath, size, onBytes, () => canceled);
        } else {
          await uploadLarge(sessionId, localPath, remotePath, size, onBytes, () => canceled);
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
    pause: () => {},
    resume: () => {},
    cancel: () => { canceled = true; },
  };
}

async function uploadSimple(
  sessionId: string,
  localPath: string,
  remotePath: string,
  size: number,
  onBytes: (n: number) => void,
  isCanceled: () => boolean
): Promise<void> {
  const data = await fsp.readFile(localPath);
  if (isCanceled()) return;
  const enc = encodePath(remotePath);
  const url = `${GRAPH}/me/drive/root:/${enc}:/content?@microsoft.graph.conflictBehavior=replace`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: { Authorization: await bearer(sessionId), "Content-Type": "application/octet-stream" },
    body: data,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`OneDrive upload failed (HTTP ${resp.status}): ${text.slice(0, 200)}`);
  }
  onBytes(size);
}

interface UploadSession { uploadUrl: string; }

async function uploadLarge(
  sessionId: string,
  localPath: string,
  remotePath: string,
  size: number,
  onBytes: (n: number) => void,
  isCanceled: () => boolean
): Promise<void> {
  const enc = encodePath(remotePath);
  const session = await graph<UploadSession>(sessionId, `${GRAPH}/me/drive/root:/${enc}:/createUploadSession`, {
    method: "POST",
    body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }),
  });

  let offset = 0;
  const stream = createReadStream(localPath, { highWaterMark: UPLOAD_CHUNK });
  for await (const chunk of stream) {
    if (isCanceled()) { stream.destroy(); return; }
    const buf = chunk as Buffer;
    const start = offset;
    const end = offset + buf.length - 1;
    // The upload-session PUT is unauthenticated (the uploadUrl carries its own token).
    const resp = await fetch(session.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(buf.length),
        "Content-Range": `bytes ${start}-${end}/${size}`,
      },
      body: buf,
    });
    if (!resp.ok && resp.status !== 202 && resp.status !== 201 && resp.status !== 200) {
      const text = await resp.text().catch(() => "");
      throw new Error(`OneDrive chunk upload failed (HTTP ${resp.status}): ${text.slice(0, 200)}`);
    }
    offset += buf.length;
    onBytes(offset);
  }
}

export const onedriveBackend: RemoteBackend = {
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
