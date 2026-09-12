// Protocol-neutral backend abstraction (Electron main process). Both the SFTP
// engine and the WebDAV engine implement RemoteBackend, so the transfer manager
// and IPC layer can operate on a sessionId without knowing the protocol. New
// protocols (S3, FTPS, …) can be added later by implementing this interface and
// registering it in registry.ts.

import type { Site, RemoteListing, HostKeyPrompt } from "../../src/shared/types.js";

/** Successful connect: an opaque session id plus the directory to open. */
export interface ConnectOutcome {
  ok: true;
  sessionId: string;
  cwd: string;
}

/** Result of a connect attempt. `needsHostKeyTrust` is SFTP-specific (TOFU) and
 *  simply never returned by protocols that authenticate via TLS/PKI. */
export type EngineConnectResult =
  | ConnectOutcome
  | { ok: false; error: string }
  | { ok: false; needsHostKeyTrust: true; prompt: HostKeyPrompt };

/** One entry from a remote directory (name + kind + size), for walking trees. */
export interface RemoteChild {
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
  sizeBytes: number;
}

/** A running transfer that can be paused/resumed/canceled mid-file. */
export interface TransferControl {
  /** Resolves when the file finishes; rejects on error; resolves early if canceled. */
  done: Promise<"completed" | "canceled">;
  pause(): void;
  resume(): void;
  cancel(): void;
}

/** What a backend can do, so the manager can gate optional features per protocol. */
export interface BackendCapabilities {
  /** Resume an interrupted transfer from a byte offset. SFTP: both directions.
   *  WebDAV: download-only (HTTP Range); uploads restart from 0. */
  resumeDownload: boolean;
  resumeUpload: boolean;
  /** Post-transfer SHA-256 verification is available (needs a server-side hash). */
  checksum: boolean;
  /** Uses SSH host-key trust-on-first-use (drives the host-key prompt flow). */
  hostKeyTofu: boolean;
  /** Mid-transfer pause/resume is supported. SFTP/WebDAV stream and can pause;
   *  FTP (basic-ftp) has no mid-transfer pause, so pause is disabled in the UI
   *  and no-ops in the manager for these transfers. */
  pausable: boolean;
}

/**
 * The operations the app needs from a remote filesystem, independent of
 * protocol. Sessions are identified by the opaque id returned from connect();
 * every other method takes that id. Paths are POSIX-style ("/"-separated).
 */
export interface RemoteBackend {
  readonly capabilities: BackendCapabilities;

  connect(site: Site): Promise<EngineConnectResult>;
  disconnect(sessionId: string): void;

  /** Sorted directory listing (directories first, then by name). */
  list(sessionId: string, path: string): Promise<RemoteListing>;
  /** Rename/move. `toName` may be a bare name (rename) or an absolute path (move). */
  rename(sessionId: string, fromPath: string, toName: string): Promise<void>;
  /** Create a directory named `name` under `parentPath`. */
  mkdir(sessionId: string, parentPath: string, name: string): Promise<void>;
  /** Delete a file or directory (recursive for directories). */
  remove(sessionId: string, path: string): Promise<void>;

  // --- Transfer primitives (used by the transfer manager) ---
  /** Directory entries with kind + size, for expanding trees. */
  readdirDetailed(sessionId: string, path: string): Promise<RemoteChild[]>;
  /** Ensure a remote directory exists (mkdir -p). */
  ensureRemoteDir(sessionId: string, dir: string): Promise<void>;
  /** Size of a remote file, or -1 if it doesn't exist (for conflict/resume). */
  remoteSize(sessionId: string, path: string): Promise<number>;
  /** Download one remote file to a local path (abortable/pausable). */
  downloadFile(
    sessionId: string,
    remotePath: string,
    localPath: string,
    onBytes: (transferred: number) => void,
    startOffset?: number
  ): TransferControl;
  /** Upload one local file to a remote path (abortable/pausable). */
  uploadFile(
    sessionId: string,
    localPath: string,
    remotePath: string,
    onBytes: (transferred: number) => void,
    startOffset?: number
  ): TransferControl;
  /** Best-effort remote SHA-256 (hex), or null if unavailable. Optional: a
   *  backend without server-side hashing omits it (capabilities.checksum=false). */
  remoteSha256?(sessionId: string, path: string): Promise<string | null>;

  /** SFTP-only: true when this session performs byte transfers via rsync (opt-in
   *  + usable). Lets the manager fall back to the built-in stream path on rsync
   *  failure. Absent/false for other backends. */
  isRsyncActive?(sessionId: string): boolean;
  /** SFTP-only: after a persistent rsync failure, stop attempting rsync for this
   *  session (subsequent transfers use the built-in path directly). */
  disableRsyncForSession?(sessionId: string): void;
  /** SFTP-only: built-in stream transfer, bypassing rsync — the fallback target
   *  when an rsync transfer fails. */
  downloadFileStream?(
    sessionId: string,
    remotePath: string,
    localPath: string,
    onBytes: (transferred: number) => void,
    startOffset?: number
  ): TransferControl;
  uploadFileStream?(
    sessionId: string,
    localPath: string,
    remotePath: string,
    onBytes: (transferred: number) => void,
    startOffset?: number
  ): TransferControl;
}
