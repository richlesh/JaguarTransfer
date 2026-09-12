// Session registry (Electron main process). Maps each protocol to its backend
// and each live session id to the backend that owns it, so the transfer manager
// and IPC layer can call remote operations by sessionId without knowing which
// protocol is in use. connect() dispatches on site.protocol; every other call
// looks up the owning backend by sessionId and delegates.

import type { Site } from "../../src/shared/types.js";
import type {
  RemoteBackend,
  EngineConnectResult,
  RemoteChild,
  TransferControl,
  BackendCapabilities,
} from "./types.js";
import { sftpBackend } from "../sftp/engine.js";
import { webdavBackend } from "../webdav/engine.js";
import { ftpBackend } from "../ftp/engine.js";
import { dropboxBackend } from "../dropbox/engine.js";
import { onedriveBackend } from "../onedrive/engine.js";
import { gdriveBackend } from "../gdrive/engine.js";

/** Backends keyed by protocol. New protocols register here. */
const backends: Record<Site["protocol"] & string, RemoteBackend> = {
  sftp: sftpBackend,
  webdav: webdavBackend,
  ftp: ftpBackend,
  dropbox: dropboxBackend,
  onedrive: onedriveBackend,
  gdrive: gdriveBackend,
};

/** sessionId → owning backend, recorded on a successful connect. */
const owner = new Map<string, RemoteBackend>();
/** sessionId → protocol, recorded on a successful connect (for UI labeling). */
const protocols = new Map<string, NonNullable<Site["protocol"]>>();

function backendForSite(site: Site): RemoteBackend {
  const proto = site.protocol ?? "sftp"; // untagged legacy sites are SFTP
  const backend = backends[proto];
  if (!backend) throw new Error(`Unsupported protocol: ${proto}`);
  return backend;
}

function backendFor(sessionId: string): RemoteBackend {
  const backend = owner.get(sessionId);
  if (!backend) throw new Error("Not connected (unknown session).");
  return backend;
}

/** Capabilities of the backend that owns a session (for feature gating). */
export function capabilitiesFor(sessionId: string): BackendCapabilities | null {
  return owner.get(sessionId)?.capabilities ?? null;
}

export async function connect(site: Site): Promise<EngineConnectResult> {
  const backend = backendForSite(site);
  const res = await backend.connect(site);
  if (res.ok) {
    owner.set(res.sessionId, backend);
    protocols.set(res.sessionId, site.protocol ?? "sftp");
  }
  return res;
}

export function disconnect(sessionId: string): void {
  const backend = owner.get(sessionId);
  if (!backend) return;
  backend.disconnect(sessionId);
  owner.delete(sessionId);
  protocols.delete(sessionId);
}

/** The protocol a session speaks ("sftp" | "webdav" | "ftp"), or null. */
export function protocolFor(sessionId: string): NonNullable<Site["protocol"]> | null {
  return protocols.get(sessionId) ?? null;
}

/** Disconnect every live session across all backends (used on app quit). */
export function disconnectAll(): void {
  for (const sessionId of [...owner.keys()]) disconnect(sessionId);
}

// ---- Delegating pass-throughs (by sessionId) ----

export function list(sessionId: string, path: string) {
  return backendFor(sessionId).list(sessionId, path);
}
export function rename(sessionId: string, fromPath: string, toName: string) {
  return backendFor(sessionId).rename(sessionId, fromPath, toName);
}
export function mkdir(sessionId: string, parentPath: string, name: string) {
  return backendFor(sessionId).mkdir(sessionId, parentPath, name);
}
export function remove(sessionId: string, path: string) {
  return backendFor(sessionId).remove(sessionId, path);
}
export function readdirDetailed(sessionId: string, path: string): Promise<RemoteChild[]> {
  return backendFor(sessionId).readdirDetailed(sessionId, path);
}
export function ensureRemoteDir(sessionId: string, dir: string): Promise<void> {
  return backendFor(sessionId).ensureRemoteDir(sessionId, dir);
}
export function remoteSize(sessionId: string, path: string): Promise<number> {
  return backendFor(sessionId).remoteSize(sessionId, path);
}
export function downloadFile(
  sessionId: string,
  remotePath: string,
  localPath: string,
  onBytes: (transferred: number) => void,
  startOffset = 0
): TransferControl {
  return backendFor(sessionId).downloadFile(sessionId, remotePath, localPath, onBytes, startOffset);
}
export function uploadFile(
  sessionId: string,
  localPath: string,
  remotePath: string,
  onBytes: (transferred: number) => void,
  startOffset = 0
): TransferControl {
  return backendFor(sessionId).uploadFile(sessionId, localPath, remotePath, onBytes, startOffset);
}
/** Best-effort remote SHA-256, or null when the backend can't compute one. */
export function remoteSha256(sessionId: string, path: string): Promise<string | null> {
  const backend = backendFor(sessionId);
  return backend.remoteSha256 ? backend.remoteSha256(sessionId, path) : Promise.resolve(null);
}

/** True when this session transfers bytes via rsync (SFTP opt-in). */
export function isRsyncActive(sessionId: string): boolean {
  const backend = owner.get(sessionId);
  return backend?.isRsyncActive ? backend.isRsyncActive(sessionId) : false;
}

/** Stop attempting rsync for this session after a persistent failure. */
export function disableRsyncForSession(sessionId: string): void {
  owner.get(sessionId)?.disableRsyncForSession?.(sessionId);
}

/** Built-in stream download bypassing rsync (fallback on rsync failure). Falls
 *  back to the normal downloadFile if the backend has no stream variant. */
export function downloadFileStream(
  sessionId: string,
  remotePath: string,
  localPath: string,
  onBytes: (transferred: number) => void,
  startOffset = 0
): TransferControl {
  const backend = backendFor(sessionId);
  return (backend.downloadFileStream ?? backend.downloadFile).call(
    backend,
    sessionId,
    remotePath,
    localPath,
    onBytes,
    startOffset
  );
}

/** Built-in stream upload bypassing rsync (fallback on rsync failure). */
export function uploadFileStream(
  sessionId: string,
  localPath: string,
  remotePath: string,
  onBytes: (transferred: number) => void,
  startOffset = 0
): TransferControl {
  const backend = backendFor(sessionId);
  return (backend.uploadFileStream ?? backend.uploadFile).call(
    backend,
    sessionId,
    localPath,
    remotePath,
    onBytes,
    startOffset
  );
}
