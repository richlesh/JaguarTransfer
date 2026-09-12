// App settings persisted as JSON in the user's home dir (~/.jaguartransfer-settings.json).
// Mirrors the BudgetLion settings pattern. Site profiles and known hosts live in
// their own files (sites.ts / knownHosts.ts); secrets live in the OS keychain.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppSettings } from "../src/shared/ipc.js";

const SETTINGS_PATH = join(homedir(), ".jaguartransfer-settings.json");

const DEFAULTS: AppSettings = {
  theme: "light",
  maxConcurrentTransfers: 4,
};

export function loadSettings(): AppSettings {
  try {
    const saved = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Partial<AppSettings>;
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: AppSettings): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
}

export function settingsPath(): string {
  return SETTINGS_PATH;
}
