// Electron main process entry point for TransferJaguar.

import { app, BrowserWindow, dialog } from "electron";
import { join } from "node:path";
import { registerIpcHandlers } from "../ipc/handlers.js";
import { buildMenu, showSplash, registerDialogIpc, isLicensed } from "../dialogs.js";
import { loadSettings, saveSettings } from "../settings.js";
import { disconnectAll } from "../sftp/engine.js";
import { configureManager, hasActiveTransfers, cancelAll } from "../transfer/manager.js";
import { IPC } from "../../src/shared/ipc.js";

const isDev = process.env.NODE_ENV === "development";

/** Set true once the user has confirmed quitting with active transfers, so the
 *  second (programmatic) close isn't intercepted again. */
let allowClose = false;

function createWindow(): void {
  // macOS uses the packaged .icns and ignores BrowserWindow.icon, so only set it
  // on Windows/Linux where the window/taskbar icon come from this option.
  const windowIcon =
    process.platform === "darwin"
      ? undefined
      : join(app.getAppPath(), "resources", "app_icon_256.png");

  const saved = loadSettings().windowBounds;

  const win = new BrowserWindow({
    width: saved?.width ?? 1200,
    height: saved?.height ?? 800,
    ...(saved && saved.x != null && saved.y != null ? { x: saved.x, y: saved.y } : {}),
    minWidth: 820,
    minHeight: 520,
    title: "TransferJaguar",
    show: false,
    ...(windowIcon ? { icon: windowIcon } : {}),
    webPreferences: {
      preload: join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs contextBridge; sandbox off is standard here
    },
  });

  if (isDev) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(join(__dirname, "..", "..", "..", "dist", "index.html"));
  }

  // Guard the window close/quit: if transfers are active, confirm before closing.
  win.on("close", (e) => {
    if (allowClose || !hasActiveTransfers()) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["Keep Transferring", "Cancel & Quit"],
      defaultId: 0,
      cancelId: 0,
      title: "Transfers in progress",
      message: "Transfers are still in progress.",
      detail: "Quitting now will cancel the active transfers and leave any partially transferred files in place. Quit anyway?",
      noLink: true,
    });
    if (choice === 1) {
      cancelAll();
      allowClose = true;
      win.close();
    }
  });

  win.once("ready-to-show", () => win.show());
  buildMenu(win);

  // Route transfer progress events to this window's renderer.
  configureManager({
    emit: (task) => {
      if (!win.isDestroyed()) win.webContents.send(IPC.transferProgress, task);
    },
    maxConcurrentFiles: loadSettings().maxConcurrentTransfers,
  });

  // Persist window bounds (debounced) so they restore next launch.
  let boundsTimer: NodeJS.Timeout | null = null;
  const persistBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (win.isDestroyed() || win.isMinimized()) return;
      const b = win.getBounds();
      const current = loadSettings();
      saveSettings({ ...current, windowBounds: { width: b.width, height: b.height, x: b.x, y: b.y } });
    }, 400);
  };
  win.on("resize", persistBounds);
  win.on("move", persistBounds);
}

app.whenReady().then(() => {
  registerIpcHandlers();
  registerDialogIpc();
  // Show the purchase splash on launch only for unlicensed users.
  if (!isLicensed()) showSplash();
  createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("will-quit", () => {
  disconnectAll();
});
