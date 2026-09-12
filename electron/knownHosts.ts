// Trusted host keys (TOFU) persisted as JSON (~/.jaguartransfer-known-hosts.json).
// Conceptually like OpenSSH's known_hosts: we remember the SHA-256 fingerprint
// trusted for each host:port and refuse (prompt) when it changes.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KnownHost } from "../src/shared/types.js";

const KNOWN_HOSTS_PATH = join(homedir(), ".jaguartransfer-known-hosts.json");

function readAll(): KnownHost[] {
  try {
    const data = JSON.parse(readFileSync(KNOWN_HOSTS_PATH, "utf8")) as unknown;
    return Array.isArray(data) ? (data as KnownHost[]) : [];
  } catch {
    return [];
  }
}

function writeAll(hosts: KnownHost[]): void {
  writeFileSync(KNOWN_HOSTS_PATH, JSON.stringify(hosts, null, 2), "utf8");
}

function keyMatch(h: KnownHost, host: string, port: number): boolean {
  return h.host === host && h.port === port;
}

/** The trusted entry for a host:port, or null if none. */
export function getKnownHost(host: string, port: number): KnownHost | null {
  return readAll().find((h) => keyMatch(h, host, port)) ?? null;
}

/**
 * Verify a presented key against the TOFU store.
 *  - "trusted": fingerprint matches a stored entry.
 *  - "unknown": no entry for this host yet (first contact).
 *  - "changed": an entry exists but the fingerprint differs (possible MITM).
 */
export function verifyHostKey(
  host: string,
  port: number,
  fingerprintSha256: string
): "trusted" | "unknown" | "changed" {
  const existing = getKnownHost(host, port);
  if (!existing) return "unknown";
  return existing.fingerprintSha256 === fingerprintSha256 ? "trusted" : "changed";
}

/** Persist trust for a host key (adds or replaces the entry for host:port). */
export function trustHostKey(entry: Omit<KnownHost, "trustedAtMs">): void {
  const hosts = readAll().filter((h) => !keyMatch(h, entry.host, entry.port));
  hosts.push({ ...entry, trustedAtMs: Date.now() });
  writeAll(hosts);
}
