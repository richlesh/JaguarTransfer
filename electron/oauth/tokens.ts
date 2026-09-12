// OAuth token storage + transparent refresh (Electron main process).
//
// Tokens live in the OS keychain (never in JSON), stored as a JSON blob under an
// oauth-namespaced account derived from the site id. getValidAccessToken returns
// a non-expired access token, refreshing (and re-persisting) when needed.

import { Entry } from "@napi-rs/keyring";
import type { OAuthProvider } from "./provider.js";
import type { OAuthTokens } from "./flow.js";
import { refreshTokens } from "./flow.js";

const SERVICE = "TransferJaguar";

/** Keychain account under which a site's OAuth tokens are stored. */
function oauthAccount(siteId: string): string {
  return `${siteId}:oauth`;
}

function entryFor(siteId: string): Entry {
  return new Entry(SERVICE, oauthAccount(siteId));
}

/** Persist tokens for a site (replaces any existing). */
export function storeTokens(siteId: string, tokens: OAuthTokens): void {
  try {
    entryFor(siteId).setPassword(JSON.stringify(tokens));
  } catch {
    // Best-effort; if the keychain is unavailable, connecting will fail later.
  }
}

/** Load tokens for a site, or null if none / unreadable. */
export function loadTokens(siteId: string): OAuthTokens | null {
  try {
    const raw = entryFor(siteId).getPassword();
    return raw ? (JSON.parse(raw) as OAuthTokens) : null;
  } catch {
    return null;
  }
}

/** Remove a site's stored tokens (on delete / disconnect). */
export function deleteTokens(siteId: string): void {
  try {
    entryFor(siteId).deletePassword();
  } catch {
    /* ignore */
  }
}

/** True when a site has stored OAuth tokens (i.e. it's been connected). */
export function hasTokens(siteId: string): boolean {
  return loadTokens(siteId) !== null;
}

/** Skew (ms) before actual expiry at which we proactively refresh. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * Return a valid access token for a site, refreshing via the refresh token when
 * the current one is missing/expired and re-persisting the result. Throws if the
 * site isn't connected or can't be refreshed (caller should prompt reconnect).
 */
export async function getValidAccessToken(provider: OAuthProvider, siteId: string): Promise<string> {
  const tokens = loadTokens(siteId);
  if (!tokens) throw new Error("Not connected to this account. Use “Connect” in the site editor.");

  const stillValid = tokens.expiresAtMs === 0 || Date.now() < tokens.expiresAtMs - EXPIRY_SKEW_MS;
  if (stillValid && tokens.accessToken) return tokens.accessToken;

  if (!tokens.refreshToken) {
    throw new Error("Session expired and no refresh token is available. Please reconnect the account.");
  }
  const refreshed = await refreshTokens(provider, tokens.refreshToken);
  storeTokens(siteId, refreshed);
  return refreshed.accessToken;
}
