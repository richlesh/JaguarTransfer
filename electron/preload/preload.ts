// Preload: exposes a typed, minimal API on window.jaguar via contextBridge.
// The renderer never gets direct Node/Electron access.

import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../../src/shared/ipc.js";
import type { AppSettings, JaguarApi } from "../../src/shared/ipc.js";
import type { SiteInput, HostKeyPrompt } from "../../src/shared/types.js";

const api: JaguarApi = {
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  saveSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.saveSettings, patch),

  listSites: () => ipcRenderer.invoke(IPC.listSites),
  saveSite: (input: SiteInput) => ipcRenderer.invoke(IPC.saveSite, input),
  deleteSite: (id: string) => ipcRenderer.invoke(IPC.deleteSite, id),

  connect: (siteId: string) => ipcRenderer.invoke(IPC.connect, siteId),
  disconnect: (sessionId: string) => ipcRenderer.invoke(IPC.disconnect, sessionId),
  hostkeyTrust: (prompt: HostKeyPrompt) => ipcRenderer.invoke(IPC.hostkeyTrust, prompt),

  remoteList: (sessionId: string, path: string) => ipcRenderer.invoke(IPC.remoteList, sessionId, path),

  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
};

contextBridge.exposeInMainWorld("jaguar", api);
