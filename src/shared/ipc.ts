// Contract for the IPC bridge exposed on window.transferJaguar by the preload script.
// Shared so both preload (implementation) and renderer (consumer) stay in sync.

import type {
  Site,
  SiteInput,
  RemoteListing,
  ConnectResult,
  HostKeyPrompt,
  TransferRequest,
  TransferTask,
  ConnectionStateEvent,
} from "./types";

/** Outcome of a "Test Connection" attempt with unsaved form values. */
export type TestConnectionResult =
  | { ok: true; detail?: string }
  /** Reachable, but the SSH host key isn't trusted yet (TOFU). Treated as a
   *  soft pass: the server answered, trust is decided on the real connect. */
  | { ok: true; hostKeyUntrusted: true; detail: string }
  | { ok: false; error: string };

/** Outcome of an OAuth "Connect" flow (Dropbox / OneDrive). */
export type OAuthConnectResult =
  | { ok: true; account: string | null }
  | { ok: false; error: string };

/** App-level settings persisted to ~/.transferjaguar-settings.json. */
export interface AppSettings {
  theme: "light" | "dark";
  windowBounds?: { width: number; height: number; x?: number; y?: number };
  /** Show dotfiles (names starting with ".") in the file panes. Default off. */
  showHiddenFiles?: boolean;
  /** Where directories appear in the file list relative to files. Default "top". */
  directorySort?: "top" | "inline" | "bottom";
  /** Default conflict policy when a transfer destination exists. Default "ask"
   *  (prompt the user: Replace / Keep both / Cancel). */
  conflictPolicy?: "ask" | "overwrite" | "skip" | "rename";
  /** Verify each transferred file with a SHA-256 checksum (needs sha256sum on the
   *  server; best-effort). Default off. */
  verifyChecksum?: boolean;
  /** Max concurrent transfers (used later, M3). */
  maxConcurrentTransfers?: number;
  /** License info (set via the License dialog). */
  licenseKey?: string;
  userName?: string;
  /** Count of transfer requests (a multi-select gesture = 1); drives the
   *  periodic purchase nag for unlicensed users. */
  transferRequestCount?: number;
}

/** The API surface exposed to the renderer via contextBridge (window.transferJaguar). */
export interface TransferJaguarApi {
  // Settings
  getSettings(): Promise<AppSettings>;
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>;

  // Site profiles (CRUD). Secrets are routed to the OS keychain, not the JSON.
  listSites(): Promise<Site[]>;
  saveSite(input: SiteInput): Promise<Site>;
  deleteSite(id: string): Promise<void>;
  /** Try connecting with the given (unsaved) form values. Persists nothing:
   *  any provided secret is used for the attempt only and not stored. */
  testConnection(input: SiteInput): Promise<TestConnectionResult>;
  /** Open a native file picker and return the chosen absolute path, or null if
   *  canceled. Used e.g. to locate the rsync executable. */
  pickFile(options?: { title?: string; defaultPath?: string }): Promise<string | null>;
  /** Run the OAuth consent flow for a (saved) OAuth site (Dropbox / OneDrive)
   *  and store its tokens. Returns the connected account label on success. */
  oauthConnect(siteId: string): Promise<OAuthConnectResult>;

  // Connection lifecycle
  connect(siteId: string): Promise<ConnectResult>;
  disconnect(sessionId: string): Promise<void>;

  // Host-key TOFU: trust the presented key, then the UI retries connect().
  hostkeyTrust(prompt: HostKeyPrompt): Promise<void>;

  // Remote browsing
  remoteList(sessionId: string, path: string): Promise<RemoteListing>;
  // Remote operations
  remoteRename(sessionId: string, fromPath: string, toName: string): Promise<void>;
  remoteMkdir(sessionId: string, parentPath: string, name: string): Promise<void>;
  remoteDelete(sessionId: string, path: string): Promise<void>;

  // Local browsing + operations
  localHome(): Promise<string>;
  localList(path: string): Promise<RemoteListing>;
  localRename(fromPath: string, toName: string): Promise<void>;
  localMkdir(parentPath: string, name: string): Promise<void>;
  localDelete(path: string): Promise<void>;

  // Transfers
  transferEnqueue(req: TransferRequest): Promise<string>;
  transferCancel(id: string): Promise<void>;
  transferPause(id: string): Promise<void>;
  transferResume(id: string): Promise<void>;
  transferList(): Promise<TransferTask[]>;
  transferClearFinished(): Promise<void>;
  /** Record one transfer request gesture (multi-select = 1); nags if unlicensed. */
  recordTransferRequest(): Promise<void>;
  /** Subscribe to per-task progress updates. Returns an unsubscribe function. */
  onTransferProgress(cb: (task: TransferTask) => void): () => void;
  /** Subscribe to transient transfer notices (e.g. "rsync failed, using the
   *  built-in transfer"). Returns an unsubscribe function. */
  onTransferNotice(cb: (message: string) => void): () => void;

  /** Fired when the user picks Settings from the native menu. Returns unsubscribe. */
  onOpenSettings(cb: () => void): () => void;

  /** Subscribe to SSH connection-state changes (reconnecting/connected/dropped). */
  onConnectionState(cb: (e: ConnectionStateEvent) => void): () => void;

  // Utilities
  openExternal(url: string): Promise<void>;
}

/** IPC channel names. Kept in one place so preload + handlers can't drift. */
export const IPC = {
  getSettings: "settings:get",
  saveSettings: "settings:save",
  listSites: "sites:list",
  saveSite: "sites:save",
  deleteSite: "sites:delete",
  testConnection: "sites:test",
  pickFile: "app:pick-file",
  oauthConnect: "oauth:connect",
  connect: "conn:connect",
  disconnect: "conn:disconnect",
  hostkeyTrust: "hostkey:trust",
  remoteList: "remote:list",
  remoteRename: "remote:rename",
  remoteMkdir: "remote:mkdir",
  remoteDelete: "remote:delete",
  localHome: "local:home",
  localList: "local:list",
  localRename: "local:rename",
  localMkdir: "local:mkdir",
  localDelete: "local:delete",
  transferEnqueue: "transfer:enqueue",
  transferCancel: "transfer:cancel",
  transferPause: "transfer:pause",
  transferResume: "transfer:resume",
  transferList: "transfer:list",
  transferClearFinished: "transfer:clearFinished",
  recordTransferRequest: "transfer:recordRequest",
  /** main → renderer push channel for progress updates. */
  transferProgress: "transfer:progress",
  /** main → renderer: transient transfer notice (e.g. rsync fallback). */
  transferNotice: "transfer:notice",
  /** main → renderer: open the Settings dialog (from the native menu). */
  openSettings: "open-settings",
  /** main → renderer: SSH connection-state changes. */
  connectionState: "conn:state",
  openExternal: "app:open-external",
} as const;
