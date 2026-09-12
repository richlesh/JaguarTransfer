// Native menu + splash/about windows, following the BudgetLion pattern. Splash
// shows on launch (until we add licensing, it's a simple welcome/donate splash);
// About is opened from the app menu. Both receive the icon path and app version
// over IPC and read the theme via "settings-get".

import { app, BrowserWindow, Menu, ipcMain, shell } from "electron";
import { join } from "node:path";
import { loadSettings, saveSettings } from "./settings.js";

const HOMEPAGE = "https://glowingcat.com/TransferJaguar.html";
const ISSUES = "https://github.com/richlesh/TransferJaguar/issues";

// License validation lives in plain CJS at the app root (shared with the dialog
// HTML). Loaded via require so both TS and the HTML use the same implementation.
const appRoot = app.getAppPath();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isValidLicense } = require(join(appRoot, "utilities.cjs")) as {
  isValidLicense: (key: string, userName: string) => boolean;
};

/** True when the current settings carry a valid (key + email) license. */
export function isLicensed(): boolean {
  const s = loadSettings();
  return !!(s.licenseKey && s.userName && isValidLicense(s.licenseKey, s.userName));
}

function iconPath(): string {
  return join(app.getAppPath(), "resources", "app_icon_256.png");
}

let aboutWin: BrowserWindow | null = null;
let splashWin: BrowserWindow | null = null;

export function showSplash(): void {
  if (splashWin) return;
  splashWin = new BrowserWindow({
    width: 360,
    height: 380,
    resizable: false,
    frame: false,
    show: false,
    center: true,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  splashWin.loadFile(join(app.getAppPath(), "dialogs", "splash.html"));
  splashWin.once("ready-to-show", () => {
    splashWin?.show();
    // Raise above the main window (which is created after the splash on launch).
    splashWin?.moveTop();
    splashWin?.focus();
    splashWin?.webContents.send("icon-path", iconPath());
    splashWin?.webContents.send("app-version", app.getVersion());
  });
  splashWin.on("closed", () => (splashWin = null));
}

/**
 * Record ONE transfer request (a user gesture — a multi-select counts as one),
 * incrementing a persisted counter. Every 10th request, show the purchase splash
 * for unlicensed users. Returns the new count. Licensed users are never nagged.
 */
export function recordTransferRequest(): number {
  const s = loadSettings();
  const count = (s.transferRequestCount ?? 0) + 1;
  try {
    saveSettings({ ...s, transferRequestCount: count });
  } catch {
    // best-effort; still nag based on the in-memory count
  }
  if (count > 0 && count % 10 === 0 && !isLicensed()) {
    showSplash();
  }
  return count;
}

// ---- License dialog ----
let licenseWin: BrowserWindow | null = null;
export function openLicense(): void {
  if (licenseWin && !licenseWin.isDestroyed()) return licenseWin.focus();
  licenseWin = new BrowserWindow({
    width: 400,
    height: 300,
    resizable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  licenseWin.setMenuBarVisibility(false);
  licenseWin.loadFile(join(app.getAppPath(), "dialogs", "license.html"));
  licenseWin.webContents.once("did-finish-load", () => {
    const s = loadSettings();
    licenseWin?.webContents.send("license-data", { key: s.licenseKey || "", userName: s.userName || "" });
  });
  licenseWin.on("closed", () => (licenseWin = null));
}

ipcMain.handle("license-save", (_e, { key, userName }: { key: string; userName: string }) => {
  if (!isValidLicense(key, userName)) return;
  const s = loadSettings();
  saveSettings({ ...s, licenseKey: key.toUpperCase(), userName });
  licenseWin?.close();
});
ipcMain.handle("license-cancel", () => licenseWin?.close());

function showAbout(): void {
  if (aboutWin) {
    aboutWin.focus();
    return;
  }
  aboutWin = new BrowserWindow({
    width: 380,
    height: 420,
    resizable: false,
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  aboutWin.loadFile(join(app.getAppPath(), "dialogs", "about.html"));
  aboutWin.once("ready-to-show", () => {
    aboutWin?.show();
    aboutWin?.webContents.send("icon-path", iconPath());
    aboutWin?.webContents.send("app-version", app.getVersion());
  });
  aboutWin.on("closed", () => (aboutWin = null));
}

/** Register the small dialog-support IPC channels used by splash/about HTML. */
export function registerDialogIpc(): void {
  ipcMain.handle("settings-get", () => loadSettings());
  ipcMain.handle("open-external", (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
    return Promise.resolve();
  });
  ipcMain.on("splash-close", () => {
    splashWin?.close();
    splashWin = null;
  });
  ipcMain.handle("close-about", () => {
    aboutWin?.close();
    aboutWin = null;
  });
}

export function buildMenu(win: BrowserWindow): void {
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { label: `About ${app.name}`, click: () => showAbout() },
              { type: "separator" as const },
              {
                label: "Settings…",
                accelerator: "Cmd+,",
                click: () => win.webContents.send("open-settings"),
              },
              { label: "License Key…", click: () => openLicense() },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "quit" as const },
            ],
          } as Electron.MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        ...(!isMac
          ? [
              {
                label: "Settings",
                accelerator: "Ctrl+,",
                click: () => win.webContents.send("open-settings"),
              } as Electron.MenuItemConstructorOptions,
              { label: "License Key…", click: () => openLicense() } as Electron.MenuItemConstructorOptions,
              { type: "separator" as const },
            ]
          : []),
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Help",
      submenu: [
        { label: "TransferJaguar Website", click: () => shell.openExternal(HOMEPAGE) },
        { label: "Report an Issue", click: () => shell.openExternal(ISSUES) },
        ...(isMac
          ? []
          : [
              { type: "separator" as const },
              { label: "About TransferJaguar", click: () => showAbout() } as Electron.MenuItemConstructorOptions,
            ]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
