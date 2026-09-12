// Site profiles persisted as JSON (~/.transferjaguar-sites.json). Contains NO
// secrets — passwords and key passphrases live in the OS keychain (secrets.ts),
// referenced by the site id.

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Site, SiteInput } from "../src/shared/types.js";

const SITES_PATH = join(homedir(), ".transferjaguar-sites.json");

function readAll(): Site[] {
  try {
    const data = JSON.parse(readFileSync(SITES_PATH, "utf8")) as unknown;
    return Array.isArray(data) ? (data as Site[]) : [];
  } catch {
    return [];
  }
}

function writeAll(sites: Site[]): void {
  writeFileSync(SITES_PATH, JSON.stringify(sites, null, 2), "utf8");
}

export function listSites(): Site[] {
  return readAll().sort((a, b) => a.name.localeCompare(b.name));
}

/** Strip any transient secret and normalize into a stored Site. */
function toStored(input: SiteInput, id: string): Site {
  return {
    id,
    name: input.name.trim(),
    host: input.host.trim(),
    port: input.port || 22,
    username: input.username.trim(),
    authMethod: input.authMethod,
    privateKeyPath: input.privateKeyPath?.trim() || undefined,
    startDir: input.startDir?.trim() || undefined,
    compression: !!input.compression,
    jumpHost: input.jumpHost?.trim() || undefined,
  };
}

/** Create or update a site. Returns the stored profile (without any secret). */
export function saveSite(input: SiteInput): Site {
  const sites = readAll();
  const id = input.id ?? randomUUID();
  const stored = toStored(input, id);
  const idx = sites.findIndex((s) => s.id === id);
  if (idx >= 0) sites[idx] = stored;
  else sites.push(stored);
  writeAll(sites);
  return stored;
}

export function getSite(id: string): Site | null {
  return readAll().find((s) => s.id === id) ?? null;
}

export function deleteSite(id: string): void {
  writeAll(readAll().filter((s) => s.id !== id));
}
