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
  const protocol = input.protocol ?? "sftp";
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
    protocol,
    useRsync: protocol === "sftp" ? !!input.useRsync : undefined,
    rsyncPath: protocol === "sftp" && input.useRsync ? input.rsyncPath?.trim() || undefined : undefined,
    baseUrl: protocol === "webdav" ? input.baseUrl?.trim() || undefined : undefined,
    webdavAuth: protocol === "webdav" ? input.webdavAuth ?? "basic" : undefined,
    ftpSecurity: protocol === "ftp" ? input.ftpSecurity ?? "explicit" : undefined,
    dropboxStartPath: protocol === "dropbox" ? input.dropboxStartPath?.trim() || undefined : undefined,
    dropboxAccount: protocol === "dropbox" ? input.dropboxAccount?.trim() || undefined : undefined,
    onedriveStartPath: protocol === "onedrive" ? input.onedriveStartPath?.trim() || undefined : undefined,
    onedriveAccount: protocol === "onedrive" ? input.onedriveAccount?.trim() || undefined : undefined,
    gdriveStartPath: protocol === "gdrive" ? input.gdriveStartPath?.trim() || undefined : undefined,
    gdriveAccount: protocol === "gdrive" ? input.gdriveAccount?.trim() || undefined : undefined,
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
