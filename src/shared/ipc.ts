// Contract for the IPC bridge exposed on window.jaguar by the preload script.
// Shared so both preload (implementation) and renderer (consumer) stay in sync.

import type {
  Site,
  SiteInput,
  RemoteListing,
  ConnectResult,
  HostKeyPrompt,
} from "./types";

/** App-level settings persisted to ~/.jaguartransfer-settings.json. */
export interface AppSettings {
  theme: "light" | "dark";
  windowBounds?: { width: number; height: number; x?: number; y?: number };
  /** Max concurrent transfers (used later, M3). */
  maxConcurrentTransfers?: number;
  /** License info (set via a future License dialog). */
  licenseKey?: string;
  userName?: string;
}

/** The API surface exposed to the renderer via contextBridge (window.jaguar). */
export interface JaguarApi {
  // Settings
  getSettings(): Promise<AppSettings>;
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>;

  // Site profiles (CRUD). Secrets are routed to the OS keychain, not the JSON.
  listSites(): Promise<Site[]>;
  saveSite(input: SiteInput): Promise<Site>;
  deleteSite(id: string): Promise<void>;

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
  openExternal: "app:open-external",
} as const;
