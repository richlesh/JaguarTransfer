// Registers all IPC handlers for TransferJaguar. The renderer talks to these via
// the typed window.transferJaguar bridge (preload). All filesystem/network/secret access
// happens here in the main process; the renderer is sandboxed.

import { ipcMain, shell, dialog, BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { IPC } from "../../src/shared/ipc.js";
import type { AppSettings, TestConnectionResult, OAuthConnectResult } from "../../src/shared/ipc.js";
import type { SiteInput, HostKeyPrompt, TransferRequest, Site } from "../../src/shared/types.js";
import { loadSettings, saveSettings } from "../settings.js";
import { listSites, saveSite, deleteSite, getSite } from "../sites.js";
import { setSecret, deleteSecret, jumpAccount, getSecret } from "../secrets.js";
import { trustHostKey } from "../knownHosts.js";
import { connect, disconnect, list, rename as remoteRename, mkdir as remoteMkdir, remove as remoteRemove } from "../backend/registry.js";
import { DROPBOX_PROVIDER, ONEDRIVE_PROVIDER, GOOGLE_PROVIDER, isProviderConfigured } from "../oauth/provider.js";
import type { OAuthProvider } from "../oauth/provider.js";
import { runConsentFlow } from "../oauth/flow.js";
import { storeTokens, deleteTokens } from "../oauth/tokens.js";
import { accountLabel as dropboxAccountLabel } from "../dropbox/engine.js";
import { accountLabel as onedriveAccountLabel } from "../onedrive/engine.js";
import { accountLabel as gdriveAccountLabel } from "../gdrive/engine.js";
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
    // Route any provided secrets to the keychain (never persisted in JSON).
    if (typeof input.secret === "string" && input.secret.length > 0) {
      setSecret(site.id, input.secret);
    }
    if (typeof input.jumpSecret === "string" && input.jumpSecret.length > 0) {
      setSecret(jumpAccount(site.id), input.jumpSecret);
    }
    return site;
  });
  ipcMain.handle(IPC.deleteSite, (_e, id: string) => {
    deleteSecret(id);
    deleteSecret(jumpAccount(id));
    deleteTokens(id);
    deleteSite(id);
  });

  // OAuth (Dropbox / OneDrive): run the consent flow for a saved site, store its
  // tokens, and record the connected account label on the site.
  ipcMain.handle(IPC.oauthConnect, async (_e, siteId: string): Promise<OAuthConnectResult> => {
    const site = getSite(siteId);
    if (!site) return { ok: false, error: "Save the site before connecting." };

    // Pick the provider + account-label fetcher for this site's protocol.
    let provider: OAuthProvider;
    let getLabel: (sessionId: string) => Promise<string | null>;
    if (site.protocol === "onedrive") {
      provider = ONEDRIVE_PROVIDER;
      getLabel = onedriveAccountLabel;
    } else if (site.protocol === "gdrive") {
      provider = GOOGLE_PROVIDER;
      getLabel = gdriveAccountLabel;
    } else {
      provider = DROPBOX_PROVIDER;
      getLabel = dropboxAccountLabel;
    }
    if (!isProviderConfigured(provider)) {
      return { ok: false, error: `${provider.id} isn't configured in this build (missing client ID).` };
    }

    try {
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined;
      const tokens = await runConsentFlow(provider, parent);
      storeTokens(siteId, tokens);
      // Briefly connect to read the account label, then persist it on the site.
      let account: string | null = null;
      const res = await connect(site);
      if (res.ok) {
        account = await getLabel(res.sessionId);
        disconnect(res.sessionId);
      }
      if (site.protocol === "onedrive") {
        saveSite({ ...site, onedriveAccount: account ?? undefined });
      } else if (site.protocol === "gdrive") {
        saveSite({ ...site, gdriveAccount: account ?? undefined });
      } else {
        saveSite({ ...site, dropboxAccount: account ?? undefined });
      }
      return { ok: true, account };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // Test a connection using the CURRENT (unsaved) form values, persisting
  // nothing. We build a throwaway Site under a temporary id and, for the
  // duration of the attempt only, place the relevant secret(s) in the keychain
  // under that temp id — then always clean them up (and disconnect any session)
  // in a finally block. If the form left a secret blank while editing an
  // existing site, we reuse that site's already-stored secret for the test.
  ipcMain.handle(IPC.testConnection, async (_e, input: SiteInput): Promise<TestConnectionResult> => {
    const tempId = `test:${randomUUID()}`;
    const existing = input.id ? getSite(input.id) : null;

    // Resolve which secrets to use for the attempt.
    const siteSecret =
      typeof input.secret === "string" && input.secret.length > 0
        ? input.secret
        : input.id
          ? getSecret(input.id)
          : null;
    const jumpSecret =
      typeof input.jumpSecret === "string" && input.jumpSecret.length > 0
        ? input.jumpSecret
        : input.id
          ? getSecret(jumpAccount(input.id))
          : null;

    if (siteSecret) setSecret(tempId, siteSecret);
    if (jumpSecret) setSecret(jumpAccount(tempId), jumpSecret);

    // Build a throwaway Site the backends can consume, keyed by the temp id.
    const protocol = input.protocol ?? existing?.protocol ?? "sftp";
    const site: Site = {
      id: tempId,
      name: input.name?.trim() || "test",
      host: input.host?.trim() || "",
      port: input.port || 22,
      username: input.username?.trim() || "",
      authMethod: input.authMethod,
      privateKeyPath: input.privateKeyPath?.trim() || undefined,
      startDir: input.startDir?.trim() || undefined,
      compression: !!input.compression,
      protocol,
      baseUrl: protocol === "webdav" ? input.baseUrl?.trim() || undefined : undefined,
      webdavAuth: protocol === "webdav" ? input.webdavAuth ?? "basic" : undefined,
      ftpSecurity: protocol === "ftp" ? input.ftpSecurity ?? "explicit" : undefined,
      jump:
        protocol === "sftp" && input.jump && input.jump.enabled && input.jump.host.trim()
          ? {
              enabled: true,
              host: input.jump.host.trim(),
              port: input.jump.port || 22,
              username: input.jump.username.trim(),
              authMethod: input.jump.authMethod,
              privateKeyPath: input.jump.privateKeyPath?.trim() || undefined,
            }
          : undefined,
    };

    let sessionId: string | null = null;
    try {
      const res = await connect(site);
      if (res.ok) {
        sessionId = res.sessionId;
        return { ok: true, detail: `Connected. Opened ${res.cwd}.` };
      }
      if ("needsHostKeyTrust" in res && res.needsHostKeyTrust) {
        // The server answered; only host-key trust is missing. Soft pass.
        return {
          ok: true,
          hostKeyUntrusted: true,
          detail: "Reachable — the server's host key isn't trusted yet. You'll be asked to verify it on connect.",
        };
      }
      return { ok: false, error: "error" in res ? res.error : "Connection failed." };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      if (sessionId) {
        try { disconnect(sessionId); } catch { /* noop */ }
      }
      // Never leave the temporary secrets behind.
      deleteSecret(tempId);
      deleteSecret(jumpAccount(tempId));
    }
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
  ipcMain.handle(IPC.pickFile, async (_e, options?: { title?: string; defaultPath?: string }) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined;
    const result = await dialog.showOpenDialog(win!, {
      title: options?.title ?? "Choose a file",
      defaultPath: options?.defaultPath,
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    // Only allow http/https to be opened externally.
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
    return Promise.resolve();
  });
}
