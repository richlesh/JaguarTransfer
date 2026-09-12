// Secret storage backed by the OS keychain via @napi-rs/keyring (Keychain on
// macOS, Credential Manager on Windows, libsecret on Linux). We store one secret
// per site (its password OR key passphrase), keyed by the site id. Secrets never
// touch the settings/sites JSON files.

import { Entry } from "@napi-rs/keyring";

const SERVICE = "JaguarTransfer";

function entryFor(siteId: string): Entry {
  // account = the site id; service groups all of our credentials.
  return new Entry(SERVICE, siteId);
}

/** Store (or replace) the secret for a site. */
export function setSecret(siteId: string, secret: string): void {
  try {
    entryFor(siteId).setPassword(secret);
  } catch {
    // Best-effort: if the platform keychain is unavailable, connecting with a
    // password/passphrase will simply prompt/fail later rather than crash here.
  }
}

/** Retrieve the secret for a site, or null if none / unavailable. */
export function getSecret(siteId: string): string | null {
  try {
    return entryFor(siteId).getPassword();
  } catch {
    return null;
  }
}

/** Remove the stored secret for a site (on delete). */
export function deleteSecret(siteId: string): void {
  try {
    entryFor(siteId).deletePassword();
  } catch {
    // Ignore: nothing stored, or keychain unavailable.
  }
}
