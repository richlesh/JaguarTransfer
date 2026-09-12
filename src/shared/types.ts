// Shared domain types for TransferJaguar, used by both the Electron main process
// and the React renderer. Kept free of any Node/Electron imports.

/** How to authenticate to an SFTP server. */
export type AuthMethod = "key" | "agent" | "password";

/** Transfer protocol a site speaks. Existing (untagged) sites are SFTP. */
export type Protocol = "sftp" | "webdav" | "ftp" | "dropbox" | "onedrive" | "gdrive";

/** How to authenticate to a WebDAV server. */
export type WebdavAuth = "basic" | "bearer" | "none";

/** FTP transport security. "explicit" = FTPS via AUTH TLS (port 21),
 *  "implicit" = FTPS with TLS from connect (port 990), "none" = plain FTP
 *  (unencrypted — discouraged). */
export type FtpSecurity = "explicit" | "implicit" | "none";

/** A saved connection profile. Secrets (password, key passphrase) are NEVER
 *  stored here — they live in the OS keychain, referenced by this site's id. */
export interface Site {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  /** For authMethod "key": absolute path to the private key file. */
  privateKeyPath?: string;
  /** Remote directory to open on connect (empty = server default / home). */
  startDir?: string;
  /** Opt-in SSH compression (zlib@openssh.com) — helps on slow links. */
  compression?: boolean;
  /** Jump host / bastion: connect through this host to reach the target. */
  jump?: JumpHost;
  /** SFTP only: use the local `rsync` binary (over SSH) for file copies when
   *  it's usable (key/agent auth, no jump host, binary present); otherwise the
   *  app falls back to its built-in streaming transfer. */
  useRsync?: boolean;
  /** Path to the local rsync executable (platform default when empty). */
  rsyncPath?: string;

  /** Which protocol this site uses. Absent = "sftp" (back-compat with existing
   *  profiles written before multi-protocol support). */
  protocol?: Protocol;
  /** WebDAV: the full collection URL, e.g.
   *  "https://cloud.example.com/remote.php/dav/files/alice/". */
  baseUrl?: string;
  /** WebDAV: authentication scheme. The secret (password / bearer token) lives
   *  in the keychain under the site id, like SFTP secrets. */
  webdavAuth?: WebdavAuth;
  /** FTP: transport security (explicit/implicit FTPS, or plain FTP). Uses
   *  host/port/username like SFTP; the password lives in the keychain. */
  ftpSecurity?: FtpSecurity;
  /** Dropbox: optional start folder within the account (defaults to "/", the
   *  account root). OAuth tokens live in the keychain, not here. */
  dropboxStartPath?: string;
  /** Dropbox: label of the connected account (e.g. name/email), for display.
   *  Set after a successful "Connect to Dropbox". */
  dropboxAccount?: string;
  /** OneDrive: optional start folder within the drive (defaults to "/"). */
  onedriveStartPath?: string;
  /** OneDrive: label of the connected account, for display. */
  onedriveAccount?: string;
  /** Google Drive: optional start folder (defaults to "/", My Drive root). */
  gdriveStartPath?: string;
  /** Google Drive: label of the connected account (email), for display. */
  gdriveAccount?: string;
}

/** A jump host (bastion) the connection is tunneled through. Its secret
 *  (password / key passphrase) lives in the keychain under `<siteId>:jump`. */
export interface JumpHost {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  /** For authMethod "key": absolute path to the bastion's private key file. */
  privateKeyPath?: string;
}

/** Draft used to create/update a site (id optional on create). */
export interface SiteInput extends Omit<Site, "id"> {
  id?: string;
  /** Transient secret provided by the UI at save time; routed to the keychain,
   *  never persisted in the settings JSON. Empty/undefined leaves it unchanged. */
  secret?: string;
  /** Transient bastion secret (password / key passphrase); routed to the keychain
   *  under `<siteId>:jump`. Empty/undefined leaves it unchanged. */
  jumpSecret?: string;
}

/** One entry in a directory listing (local or remote share the same shape). */
export interface FsEntry {
  name: string;
  /** "file" | "directory" | "symlink" | "other". */
  kind: "file" | "directory" | "symlink" | "other";
  sizeBytes: number;
  /** Modification time as epoch milliseconds (0 when unknown). */
  modifiedMs: number;
  /** POSIX permission bits (e.g. 0o644), or null when unknown/NA. */
  mode: number | null;
}

/** A directory listing for a resolved path. */
export interface FsListing {
  path: string;
  entries: FsEntry[];
}

/** Which filesystem a pane/op targets. */
export type Side = "local" | "remote";

// Back-compat aliases (remote pane originally used these names).
export type RemoteEntry = FsEntry;
export type RemoteListing = FsListing;

/** Connection lifecycle state surfaced to the UI. */
export type ConnectionState = "idle" | "connecting" | "verifying-hostkey" | "connected" | "error";

/** A connection-state change pushed to the renderer for a session. */
export interface ConnectionStateEvent {
  sessionId: string;
  state: "connected" | "reconnecting" | "disconnected";
  /** Human-readable detail (e.g. an error or "attempt 3"). */
  detail?: string;
}

/** Result of attempting to connect. */
export type ConnectResult =
  | { ok: true; sessionId: string; cwd: string }
  | { ok: false; error: string }
  /** The server presented a host key we don't trust yet (TOFU). The UI must
   *  prompt, then call hostkeyTrust and retry the connect. */
  | { ok: false; needsHostKeyTrust: true; prompt: HostKeyPrompt };

/** Details shown to the user when a new or changed host key is seen. */
export interface HostKeyPrompt {
  host: string;
  port: number;
  keyType: string;
  /** SHA-256 fingerprint, base64 (OpenSSH style). */
  fingerprintSha256: string;
  /** True when a DIFFERENT key was previously trusted for this host (danger). */
  changed: boolean;
}

/** A trusted host key entry (TOFU store). */
export interface KnownHost {
  host: string;
  port: number;
  keyType: string;
  fingerprintSha256: string;
  trustedAtMs: number;
}

/** Transfer direction. */
export type TransferDirection = "upload" | "download";

/** How to handle a destination that already exists. "ask" (the default) means
 *  the renderer prompts the user (Replace / Keep both / Cancel) before enqueuing;
 *  the other values apply silently. The main-process manager only ever receives
 *  a resolved policy ("overwrite" | "skip" | "rename"), never "ask". */
export type ConflictPolicy = "ask" | "overwrite" | "skip" | "rename";

/** Lifecycle of a transfer task. */
export type TransferStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "canceled"
  | "error";

/** One top-level item the user asked to transfer (a file or a directory). The
 *  manager expands directories into their files internally. */
export interface TransferRequest {
  sessionId: string;
  direction: TransferDirection;
  /** Absolute source path (local path for upload; remote path for download). */
  sourcePath: string;
  /** Destination DIRECTORY (where the item is placed), on the opposite side. */
  destDir: string;
  /** The item's own name (used to build the destination path). */
  name: string;
  /** Whether the item is a directory (recursive) or a file. */
  isDirectory: boolean;
  conflictPolicy?: ConflictPolicy;
  /** Verify each file with a SHA-256 checksum after transfer (best-effort). */
  verifyChecksum?: boolean;
}

/** A queued/active transfer task, as surfaced to the renderer. */
export interface TransferTask {
  id: string;
  direction: TransferDirection;
  /** Display name (top-level item name). */
  name: string;
  /** When the transfer was initiated (epoch ms), for newest-first ordering. */
  createdAtMs: number;
  sourcePath: string;
  destPath: string;
  status: TransferStatus;
  /** Total bytes across all files in this task (0 until sized). */
  totalBytes: number;
  transferredBytes: number;
  /** Number of files in this task and how many are done. */
  fileCount: number;
  filesDone: number;
  /** Instantaneous throughput in bytes/sec (0 when not running). */
  bytesPerSec: number;
  /** Estimated seconds remaining, or null when unknown. */
  etaSeconds: number | null;
  /** Whether this transfer can be paused (false for protocols like FTP that
   *  have no mid-transfer pause). Absent is treated as pausable. */
  pausable?: boolean;
  /** Human label for the mechanism moving the bytes, shown in the queue:
   *  "SFTP", "rsync", "WebDAV", or "FTP/FTPS". */
  transferMethod?: string;
  /** Populated when status === "error". */
  error?: string;
}
