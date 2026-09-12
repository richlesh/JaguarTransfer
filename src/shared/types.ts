// Shared domain types for JaguarTransfer, used by both the Electron main process
// and the React renderer. Kept free of any Node/Electron imports.

/** How to authenticate to an SFTP server. */
export type AuthMethod = "key" | "agent" | "password";

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
  /** Jump host / bastion (fast-follow; stored now, honored later). */
  jumpHost?: string;
}

/** Draft used to create/update a site (id optional on create). */
export interface SiteInput extends Omit<Site, "id"> {
  id?: string;
  /** Transient secret provided by the UI at save time; routed to the keychain,
   *  never persisted in the settings JSON. Empty/undefined leaves it unchanged. */
  secret?: string;
}

/** One entry in a remote directory listing. */
export interface RemoteEntry {
  name: string;
  /** "file" | "directory" | "symlink" | "other". */
  kind: "file" | "directory" | "symlink" | "other";
  sizeBytes: number;
  /** Modification time as epoch milliseconds (0 when unknown). */
  modifiedMs: number;
  /** POSIX permission bits (e.g. 0o644), or null when unknown. */
  mode: number | null;
}

/** A directory listing for a resolved path. */
export interface RemoteListing {
  path: string;
  entries: RemoteEntry[];
}

/** Connection lifecycle state surfaced to the UI. */
export type ConnectionState = "idle" | "connecting" | "verifying-hostkey" | "connected" | "error";

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
