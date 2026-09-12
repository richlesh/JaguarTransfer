// Google Drive engine (Electron main process). Implements RemoteBackend over the
// Drive API v3, authenticating with an OAuth access token that refreshes
// transparently (oauth/tokens.ts).
//
// Drive is ID-ADDRESSED, not path-addressed, so this backend maintains a
// per-session path→fileId cache and resolves paths by walking from "root". It
// also handles Google-native files (Docs/Sheets/Slides), which have no raw
// bytes: they're listed, and on download they're EXPORTED to an Office/PDF
// format with the matching extension appended to the local filename.
//
// Limitations: Google-native export has no HTTP Range (whole-file only); Drive
// allows duplicate names in a folder — the resolver picks the first match.

import { createWriteStream, createReadStream, promises as fsp } from "node:fs";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { Site, RemoteEntry, RemoteListing } from "../../src/shared/types.js";
import type { RemoteBackend, RemoteChild, TransferControl, EngineConnectResult } from "../backend/types.js";
import { GOOGLE_PROVIDER, isProviderConfigured } from "../oauth/provider.js";
import { getValidAccessToken, hasTokens } from "../oauth/tokens.js";
import { pipeStreams } from "../sftp/engine.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const NATIVE_PREFIX = "application/vnd.google-apps.";
/** Upload-session chunk size (multiple of 256 KiB per Drive docs). */
const UPLOAD_CHUNK = 8 * 1024 * 1024;

/** Export map for Google-native docs → [export MIME, appended extension]. */
const EXPORT_MAP: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document": {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ext: ".docx",
  },
  "application/vnd.google-apps.spreadsheet": {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: ".xlsx",
  },
  "application/vnd.google-apps.presentation": {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ext: ".pptx",
  },
};
/** Fallback export for other Google-native types (drawings, etc.). */
const EXPORT_FALLBACK = { mime: "application/pdf", ext: ".pdf" };

function exportFor(mimeType: string): { mime: string; ext: string } {
  return EXPORT_MAP[mimeType] ?? EXPORT_FALLBACK;
}
function isNative(mimeType: string): boolean {
  return mimeType.startsWith(NATIVE_PREFIX) && mimeType !== FOLDER_MIME;
}

interface Session {
  id: string;
  siteId: string;
  /** path → fileId cache (root path "" maps to "root"). */
  idCache: Map<string, string>;
}
const sessions = new Map<string, Session>();

function sessionOrThrow(sessionId: string): Session {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("Not connected (unknown session).");
  return s;
}

async function bearer(sessionId: string): Promise<string> {
  const s = sessionOrThrow(sessionId);
  return `Bearer ${await getValidAccessToken(GOOGLE_PROVIDER, s.siteId)}`;
}

function cleanPath(p: string): string {
  if (!p || p === "/" || p === ".") return "";
  return p.replace(/^\/+/, "").replace(/\/+$/, "");
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

/** Escape a value for a Drive `q` query string literal. */
function q(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string; // Drive returns size as a string
  modifiedTime?: string;
}
interface FileList {
  files: DriveFile[];
  nextPageToken?: string;
}
interface GApiError {
  error?: { message?: string };
}

async function api<T>(sessionId: string, url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, {
    ...init,
    headers: {
      Authorization: await bearer(sessionId),
      ...(init?.headers ?? {}),
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let msg = `HTTP ${resp.status}`;
    try {
      const j = JSON.parse(text) as GApiError;
      if (j.error?.message) msg = j.error.message;
    } catch { /* keep default */ }
    throw new Error(`Google Drive request failed (${msg}).`);
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

/** Resolve a folder path to its Drive file ID (cached per session). */
async function resolveFolderId(sessionId: string, path: string): Promise<string> {
  const s = sessionOrThrow(sessionId);
  const clean = cleanPath(path);
  if (!clean) return "root";
  const cached = s.idCache.get(clean);
  if (cached) return cached;

  const parts = clean.split("/");
  let parentId = "root";
  let curPath = "";
  for (const part of parts) {
    curPath = curPath ? `${curPath}/${part}` : part;
    const hit = s.idCache.get(curPath);
    if (hit) { parentId = hit; continue; }
    const query = `'${q(parentId)}' in parents and name = '${q(part)}' and trashed = false`;
    const url = `${API}/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType)&pageSize=10`;
    const res = await api<FileList>(sessionId, url);
    const folder = res.files.find((f) => f.mimeType === FOLDER_MIME) ?? res.files[0];
    if (!folder) throw new Error(`Path not found: /${curPath}`);
    parentId = folder.id;
    s.idCache.set(curPath, parentId);
  }
  return parentId;
}

/** Resolve a full file/folder path to its Drive file metadata. */
async function resolveItem(sessionId: string, path: string): Promise<DriveFile | null> {
  const clean = cleanPath(path);
  if (!clean) return { id: "root", name: "", mimeType: FOLDER_MIME };
  const parentId = await resolveFolderId(sessionId, dirnamePosix("/" + clean));
  const name = basenamePosix(clean);
  const query = `'${q(parentId)}' in parents and name = '${q(name)}' and trashed = false`;
  const url = `${API}/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,size,modifiedTime)&pageSize=10`;
  const res = await api<FileList>(sessionId, url);
  return res.files[0] ?? null;
}

function toEntry(f: DriveFile): RemoteEntry {
  return {
    name: f.name,
    kind: f.mimeType === FOLDER_MIME ? "directory" : "file",
    sizeBytes: f.size ? Number(f.size) || 0 : 0,
    modifiedMs: f.modifiedTime ? Date.parse(f.modifiedTime) || 0 : 0,
    mode: null,
  };
}

async function listFiles(sessionId: string, path: string): Promise<DriveFile[]> {
  const folderId = await resolveFolderId(sessionId, path);
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const query = `'${q(folderId)}' in parents and trashed = false`;
    let url =
      `${API}/files?q=${encodeURIComponent(query)}` +
      `&fields=files(id,name,mimeType,size,modifiedTime),nextPageToken&pageSize=200`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    const res = await api<FileList>(sessionId, url);
    files.push(...res.files);
    // Cache child folder ids for faster subsequent resolves.
    const s = sessionOrThrow(sessionId);
    const base = cleanPath(path);
    for (const f of res.files) {
      if (f.mimeType === FOLDER_MIME) s.idCache.set(base ? `${base}/${f.name}` : f.name, f.id);
    }
    pageToken = res.nextPageToken;
  } while (pageToken);
  return files;
}

async function connect(site: Site): Promise<EngineConnectResult> {
  if (!isProviderConfigured(GOOGLE_PROVIDER)) {
    return { ok: false, error: "Google Drive isn't configured in this build (missing client ID)." };
  }
  if (!hasTokens(site.id)) {
    return { ok: false, error: "Not connected to Google Drive. Use “Connect to Google Drive” in the site editor." };
  }
  const id = randomUUID();
  sessions.set(id, { id, siteId: site.id, idCache: new Map() });
  const cwd = site.gdriveStartPath?.trim() || "/";
  try {
    await listFiles(id, cwd);
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
  const entries = (await listFiles(sessionId, target)).map(toEntry);
  entries.sort((a, b) => {
    const ad = a.kind === "directory" ? 0 : 1;
    const bd = b.kind === "directory" ? 0 : 1;
    return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
  });
  return { path: target, entries };
}

async function rename(sessionId: string, fromPath: string, toName: string): Promise<void> {
  const item = await resolveItem(sessionId, fromPath);
  if (!item) throw new Error(`Not found: ${fromPath}`);
  if (toName.startsWith("/")) {
    // Move + possibly rename.
    const oldParent = await resolveFolderId(sessionId, dirnamePosix(fromPath));
    const newParent = await resolveFolderId(sessionId, dirnamePosix(toName));
    const url =
      `${API}/files/${item.id}?addParents=${newParent}&removeParents=${oldParent}` +
      `&fields=id`;
    await api(sessionId, url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: basenamePosix(toName) }),
    });
  } else {
    await api(sessionId, `${API}/files/${item.id}?fields=id`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: toName }),
    });
  }
  sessionOrThrow(sessionId).idCache.clear(); // paths changed
}

async function mkdir(sessionId: string, parentPath: string, name: string): Promise<void> {
  const parentId = await resolveFolderId(sessionId, parentPath);
  await api(sessionId, `${API}/files?fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  sessionOrThrow(sessionId).idCache.clear();
}

async function remove(sessionId: string, path: string): Promise<void> {
  if (path === "/" || path === "") throw new Error("Refusing to delete the drive root.");
  const item = await resolveItem(sessionId, path);
  if (!item) return;
  await api(sessionId, `${API}/files/${item.id}`, { method: "DELETE" });
  sessionOrThrow(sessionId).idCache.clear();
}

async function readdirDetailed(sessionId: string, path: string): Promise<RemoteChild[]> {
  const files = await listFiles(sessionId, path);
  return files.map((f) => ({
    name: f.name,
    isDirectory: f.mimeType === FOLDER_MIME,
    isSymlink: false,
    sizeBytes: f.size ? Number(f.size) || 0 : 0,
  }));
}

async function ensureRemoteDir(sessionId: string, dir: string): Promise<void> {
  const clean = cleanPath(dir);
  if (!clean) return;
  const parts = clean.split("/");
  let parentPath = "";
  for (const part of parts) {
    const childPath = parentPath ? `${parentPath}/${part}` : part;
    let id: string | null = null;
    try {
      id = await resolveFolderId(sessionId, childPath);
    } catch {
      id = null;
    }
    if (!id) {
      await mkdir(sessionId, "/" + parentPath, part);
    }
    parentPath = childPath;
  }
}

async function remoteSize(sessionId: string, path: string): Promise<number> {
  try {
    const item = await resolveItem(sessionId, path);
    if (!item) return -1;
    return item.size ? Number(item.size) || 0 : 0;
  } catch {
    return -1;
  }
}

/** Signed-in account label (email). */
export async function accountLabel(sessionId: string): Promise<string | null> {
  try {
    const about = await api<{ user?: { emailAddress?: string; displayName?: string } }>(
      sessionId,
      `${API}/about?fields=user(emailAddress,displayName)`
    );
    return about.user?.emailAddress || about.user?.displayName || null;
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
  let piped: TransferControl | null = null;
  let canceled = false;

  const done = new Promise<"completed" | "canceled">((resolve, reject) => {
    (async () => {
      try {
        const item = await resolveItem(sessionId, remotePath);
        if (!item) throw new Error(`Not found: ${remotePath}`);
        if (canceled) return resolve("canceled");

        let url: string;
        let usableOffset = startOffset;
        let dest = localPath;
        if (isNative(item.mimeType)) {
          // Google-native: export (whole file, no Range). Append the format ext.
          const exp = exportFor(item.mimeType);
          url = `${API}/files/${item.id}/export?mimeType=${encodeURIComponent(exp.mime)}`;
          usableOffset = 0;
          if (!dest.toLowerCase().endsWith(exp.ext.toLowerCase())) dest += exp.ext;
        } else {
          url = `${API}/files/${item.id}?alt=media`;
        }

        const headers: Record<string, string> = { Authorization: await bearer(sessionId) };
        if (usableOffset > 0) headers["Range"] = `bytes=${usableOffset}-`;
        const resp = await fetch(url, { headers });
        if (!resp.ok || !resp.body) {
          const text = await resp.text().catch(() => "");
          throw new Error(`Google Drive download failed (HTTP ${resp.status}): ${text.slice(0, 200)}`);
        }
        if (canceled) return resolve("canceled");
        const write = createWriteStream(dest, usableOffset > 0 ? { flags: "a" } : {});
        const read = Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0]);
        piped = pipeStreams(read, write, onBytes, usableOffset);
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
        await uploadResumable(sessionId, localPath, remotePath, size, onBytes, () => canceled);
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

/** Resumable upload: create/replace a file's content in chunks. */
async function uploadResumable(
  sessionId: string,
  localPath: string,
  remotePath: string,
  size: number,
  onBytes: (n: number) => void,
  isCanceled: () => boolean
): Promise<void> {
  const name = basenamePosix(remotePath);
  const parentId = await resolveFolderId(sessionId, dirnamePosix(remotePath));
  const existing = await resolveItem(sessionId, remotePath);

  // Start a resumable session (create new, or update existing content).
  const initUrl = existing
    ? `${UPLOAD}/files/${existing.id}?uploadType=resumable`
    : `${UPLOAD}/files?uploadType=resumable`;
  const metadata = existing ? { name } : { name, parents: [parentId] };
  const init = await fetch(initUrl, {
    method: existing ? "PATCH" : "POST",
    headers: {
      Authorization: await bearer(sessionId),
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(size),
    },
    body: JSON.stringify(metadata),
  });
  if (!init.ok) throw new Error(`Google Drive upload init failed (HTTP ${init.status}).`);
  const uploadUrl = init.headers.get("location");
  if (!uploadUrl) throw new Error("Google Drive upload session URL missing.");

  if (size === 0) {
    // Finalize an empty file with a single zero-length PUT.
    await fetch(uploadUrl, { method: "PUT", headers: { "Content-Range": `bytes */0` } });
    onBytes(0);
    return;
  }

  let offset = 0;
  const stream = createReadStream(localPath, { highWaterMark: UPLOAD_CHUNK });
  for await (const chunk of stream) {
    if (isCanceled()) { stream.destroy(); return; }
    const buf = chunk as Buffer;
    const start = offset;
    const end = offset + buf.length - 1;
    const resp = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(buf.length),
        "Content-Range": `bytes ${start}-${end}/${size}`,
      },
      body: buf,
    });
    // 308 = incomplete (more chunks expected); 200/201 = done.
    if (resp.status !== 308 && !resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Google Drive chunk upload failed (HTTP ${resp.status}): ${text.slice(0, 200)}`);
    }
    offset += buf.length;
    onBytes(offset);
  }
}

export const gdriveBackend: RemoteBackend = {
  capabilities: {
    resumeDownload: true, // binary files via Range (native exports restart, handled internally)
    resumeUpload: false,
    checksum: false,
    hostKeyTofu: false,
    pausable: true,
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
