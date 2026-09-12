// Registers all IPC handlers for TransferJaguar. The renderer talks to these via
// the typed window.transferJaguar bridge (preload). All filesystem/network/secret access
// happens here in the main process; the renderer is sandboxed.

import { ipcMain, shell } from "electron";
import { IPC } from "../../src/shared/ipc.js";
import type { AppSettings } from "../../src/shared/ipc.js";
import type { SiteInput, HostKeyPrompt, TransferRequest } from "../../src/shared/types.js";
import { loadSettings, saveSettings } from "../settings.js";
import { listSites, saveSite, deleteSite, getSite } from "../sites.js";
import { setSecret, deleteSecret } from "../secrets.js";
import { trustHostKey } from "../knownHosts.js";
import { connect, disconnect, list, rename as remoteRename, mkdir as remoteMkdir, remove as remoteRemove } from "../sftp/engine.js";
import * as localFs from "../local/fs.js";
import * as transferManager from "../transfer/manager.js";
import { recordTransferRequest } from "../dialogs.js";

export function registerIpcHandlers(): void {
  // Settings
  ipcMain.handle(IPC.getSettings, () => loadSettings());
  ipcMain.handle(IPC.saveSettings, (_e, patch: Partial<AppSettings>) => {
    const next = { ...loadSettings(), ...patch };
    saveSettings(next);
    return next;
  });

  // Sites
  ipcMain.handle(IPC.listSites, () => listSites());
  ipcMain.handle(IPC.saveSite, (_e, input: SiteInput) => {
    const site = saveSite(input);
    // Route any provided secret to the keychain (never persisted in JSON).
    if (typeof input.secret === "string" && input.secret.length > 0) {
      setSecret(site.id, input.secret);
    }
    return site;
  });
  ipcMain.handle(IPC.deleteSite, (_e, id: string) => {
    deleteSecret(id);
    deleteSite(id);
  });

  // Connection lifecycle
  ipcMain.handle(IPC.connect, async (_e, siteId: string) => {
    const site = getSite(siteId);
    if (!site) return { ok: false as const, error: "Site not found." };
    return connect(site);
  });
  ipcMain.handle(IPC.disconnect, (_e, sessionId: string) => disconnect(sessionId));

  // Host-key TOFU: persist trust for the presented key.
  ipcMain.handle(IPC.hostkeyTrust, (_e, prompt: HostKeyPrompt) => {
    trustHostKey({
      host: prompt.host,
      port: prompt.port,
      keyType: prompt.keyType,
      fingerprintSha256: prompt.fingerprintSha256,
    });
  });

  // Remote browsing
  ipcMain.handle(IPC.remoteList, (_e, sessionId: string, path: string) => list(sessionId, path));
  // Remote operations
  ipcMain.handle(IPC.remoteRename, (_e, sessionId: string, fromPath: string, toName: string) =>
    remoteRename(sessionId, fromPath, toName)
  );
  ipcMain.handle(IPC.remoteMkdir, (_e, sessionId: string, parentPath: string, name: string) =>
    remoteMkdir(sessionId, parentPath, name)
  );
  ipcMain.handle(IPC.remoteDelete, (_e, sessionId: string, path: string) => remoteRemove(sessionId, path));

  // Local browsing + operations
  ipcMain.handle(IPC.localHome, () => localFs.homePath());
  ipcMain.handle(IPC.localList, (_e, path: string) => localFs.list(path));
  ipcMain.handle(IPC.localRename, (_e, fromPath: string, toName: string) => localFs.rename(fromPath, toName));
  ipcMain.handle(IPC.localMkdir, (_e, parentPath: string, name: string) => localFs.mkdir(parentPath, name));
  ipcMain.handle(IPC.localDelete, (_e, path: string) => localFs.remove(path));

  // Transfers
  ipcMain.handle(IPC.transferEnqueue, (_e, req: TransferRequest) => transferManager.enqueue(req));
  ipcMain.handle(IPC.transferCancel, (_e, id: string) => transferManager.cancel(id));
  ipcMain.handle(IPC.transferPause, (_e, id: string) => transferManager.pause(id));
  ipcMain.handle(IPC.transferResume, (_e, id: string) => transferManager.resume(id));
  ipcMain.handle(IPC.transferList, () => transferManager.listTasks());
  ipcMain.handle(IPC.transferClearFinished, () => transferManager.clearFinished());
  ipcMain.handle(IPC.recordTransferRequest, () => { recordTransferRequest(); });

  // Utilities
  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    // Only allow http/https to be opened externally.
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
    return Promise.resolve();
  });
}
