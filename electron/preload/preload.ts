// Preload: exposes a typed, minimal API on window.transferJaguar via contextBridge.
// The renderer never gets direct Node/Electron access.

import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../../src/shared/ipc.js";
import type { AppSettings, TransferJaguarApi } from "../../src/shared/ipc.js";
import type { SiteInput, HostKeyPrompt, TransferRequest, TransferTask } from "../../src/shared/types.js";

const api: TransferJaguarApi = {
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  saveSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.saveSettings, patch),

  listSites: () => ipcRenderer.invoke(IPC.listSites),
  saveSite: (input: SiteInput) => ipcRenderer.invoke(IPC.saveSite, input),
  deleteSite: (id: string) => ipcRenderer.invoke(IPC.deleteSite, id),

  connect: (siteId: string) => ipcRenderer.invoke(IPC.connect, siteId),
  disconnect: (sessionId: string) => ipcRenderer.invoke(IPC.disconnect, sessionId),
  hostkeyTrust: (prompt: HostKeyPrompt) => ipcRenderer.invoke(IPC.hostkeyTrust, prompt),

  remoteList: (sessionId: string, path: string) => ipcRenderer.invoke(IPC.remoteList, sessionId, path),
  remoteRename: (sessionId: string, fromPath: string, toName: string) =>
    ipcRenderer.invoke(IPC.remoteRename, sessionId, fromPath, toName),
  remoteMkdir: (sessionId: string, parentPath: string, name: string) =>
    ipcRenderer.invoke(IPC.remoteMkdir, sessionId, parentPath, name),
  remoteDelete: (sessionId: string, path: string) => ipcRenderer.invoke(IPC.remoteDelete, sessionId, path),

  localHome: () => ipcRenderer.invoke(IPC.localHome),
  localList: (path: string) => ipcRenderer.invoke(IPC.localList, path),
  localRename: (fromPath: string, toName: string) => ipcRenderer.invoke(IPC.localRename, fromPath, toName),
  localMkdir: (parentPath: string, name: string) => ipcRenderer.invoke(IPC.localMkdir, parentPath, name),
  localDelete: (path: string) => ipcRenderer.invoke(IPC.localDelete, path),

  transferEnqueue: (req: TransferRequest) => ipcRenderer.invoke(IPC.transferEnqueue, req),
  transferCancel: (id: string) => ipcRenderer.invoke(IPC.transferCancel, id),
  transferPause: (id: string) => ipcRenderer.invoke(IPC.transferPause, id),
  transferResume: (id: string) => ipcRenderer.invoke(IPC.transferResume, id),
  transferList: () => ipcRenderer.invoke(IPC.transferList),
  transferClearFinished: () => ipcRenderer.invoke(IPC.transferClearFinished),
  recordTransferRequest: () => ipcRenderer.invoke(IPC.recordTransferRequest),
  onTransferProgress: (cb: (task: TransferTask) => void) => {
    const listener = (_e: unknown, task: TransferTask) => cb(task);
    ipcRenderer.on(IPC.transferProgress, listener);
    return () => ipcRenderer.removeListener(IPC.transferProgress, listener);
  },
  onOpenSettings: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on(IPC.openSettings, listener);
    return () => ipcRenderer.removeListener(IPC.openSettings, listener);
  },

  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
};

contextBridge.exposeInMainWorld("transferJaguar", api);
