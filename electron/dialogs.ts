// Native menu + splash/about windows, following the BudgetLion pattern. Splash
// shows on launch (until we add licensing, it's a simple welcome/donate splash);
// About is opened from the app menu. Both receive the icon path and app version
// over IPC and read the theme via "settings-get".

import { app, BrowserWindow, Menu, ipcMain, shell } from "electron";
import { join } from "node:path";
import { loadSettings } from "./settings.js";

const HOMEPAGE = "https://glowingcat.com/JaguarTransfer.html";
const ISSUES = "https://github.com/richlesh/JaguarTransfer/issues";

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
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  splashWin.loadFile(join(app.getAppPath(), "dialogs", "splash.html"));
  splashWin.once("ready-to-show", () => {
    splashWin?.show();
    splashWin?.webContents.send("icon-path", iconPath());
    splashWin?.webContents.send("app-version", app.getVersion());
  });
  splashWin.on("closed", () => (splashWin = null));
}

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
              { role: "hide" as const },
              { role: "quit" as const },
            ],
          } as Electron.MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [isMac ? { role: "close" } : { role: "quit" }],
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
        { label: "JaguarTransfer Website", click: () => shell.openExternal(HOMEPAGE) },
        { label: "Report an Issue", click: () => shell.openExternal(ISSUES) },
        ...(isMac ? [] : [{ label: "About JaguarTransfer", click: () => showAbout() } as Electron.MenuItemConstructorOptions]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  void win; // reserved for future window-scoped items
}
