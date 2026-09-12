// OAuth 2.0 provider configuration + PKCE helpers (Electron main process).
//
// This is the reusable foundation for proprietary cloud services that require
// OAuth (Dropbox now; Google Drive / OneDrive later). Desktop apps use the
// Authorization Code flow with PKCE and NO client secret — the client ID is not
// a secret and can be shipped in the app (Model A). Redirects come back to a
// temporary loopback HTTP server (see loopback.ts).

import { createHash, randomBytes } from "node:crypto";

/** Static configuration for an OAuth provider. */
export interface OAuthProvider {
  /** Stable key used in logs / token storage namespacing. */
  id: string;
  /** Authorization endpoint (consent screen). */
  authorizeUrl: string;
  /** Token endpoint (code exchange + refresh). */
  tokenUrl: string;
  /** App-wide client ID (public in a PKCE desktop flow). */
  clientId: string;
  /** Optional client secret. Pure-PKCE public clients (Dropbox, Microsoft) omit
   *  this. Google's "Desktop app" clients, however, require a client_secret at
   *  the token endpoint even with PKCE — set it here for those. It is not truly
   *  confidential for an installed app, but Google's token endpoint demands it. */
  clientSecret?: string;
  /** Space-separated scopes requested. */
  scope: string;
  /** Extra params appended to the authorize URL (provider-specific). */
  extraAuthParams?: Record<string, string>;
}

/**
 * Dropbox OAuth provider (Model A: app-wide client ID baked in).
 *
 * SETUP: create an app at https://www.dropbox.com/developers/apps, choose
 * "Scoped access" + "Full Dropbox", add the redirect URI
 * "http://localhost" (the loopback server appends the actual port at runtime;
 * Dropbox allows any localhost port when "http://localhost" is registered), and
 * paste the app key below (or set the DROPBOX_CLIENT_ID env var to override).
 *
 * `token_access_type=offline` is required for Dropbox to return a refresh token.
 */
export const DROPBOX_PROVIDER: OAuthProvider = {
  id: "dropbox",
  authorizeUrl: "https://www.dropbox.com/oauth2/authorize",
  tokenUrl: "https://api.dropboxapi.com/oauth2/token",
  clientId: process.env.DROPBOX_CLIENT_ID || "PLACEHOLDER_DROPBOX_CLIENT_ID",
  scope: [
    "account_info.read",
    "files.metadata.read",
    "files.content.read",
    "files.content.write",
  ].join(" "),
  // token_access_type=offline → return a refresh token.
  // force_reapprove=true → always show the consent screen, so reconnecting after
  //   a scope change actually re-grants scopes (Dropbox would otherwise silently
  //   reissue a token with the OLD scope set if approval already existed).
  extraAuthParams: { token_access_type: "offline", force_reapprove: "true" },
};

/** True when a provider still has the placeholder client ID (not configured). */
export function isProviderConfigured(p: OAuthProvider): boolean {
  return !!p.clientId && !p.clientId.startsWith("PLACEHOLDER_");
}

/**
 * OneDrive via Microsoft Graph (Model A). Uses the "common" tenant so both
 * personal OneDrive and work/school (Microsoft 365) accounts can sign in.
 *
 * SETUP: register an app in the Azure Portal (Azure Active Directory → App
 * registrations). Set it up as a public client / "Mobile and desktop
 * applications" and add the redirect URI "http://localhost:53682/". Under API
 * permissions add delegated Microsoft Graph scopes: offline_access, User.Read,
 * Files.ReadWrite.All. Paste the Application (client) ID below or set
 * ONEDRIVE_CLIENT_ID. `offline_access` is required to receive a refresh token.
 */
export const ONEDRIVE_PROVIDER: OAuthProvider = {
  id: "onedrive",
  authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  clientId: process.env.ONEDRIVE_CLIENT_ID || "PLACEHOLDER_ONEDRIVE_CLIENT_ID",
  scope: ["offline_access", "User.Read", "Files.ReadWrite.All"].join(" "),
  // prompt=select_account lets the user pick which MS account each time.
  extraAuthParams: { prompt: "select_account" },
};

/**
 * Google Drive (Model A). Uses the installed-app / loopback flow with PKCE.
 *
 * SETUP: in the Google Cloud Console, create a project, enable the **Google
 * Drive API**, configure the OAuth consent screen (External; add yourself as a
 * Test user), then create an **OAuth client ID** of type **Desktop app**. Add
 * the redirect URI "http://localhost:53682/". Paste the client ID below or set
 * GOOGLE_CLIENT_ID. `access_type=offline` + `prompt=consent` are required for
 * Google to return a refresh token.
 */
export const GOOGLE_PROVIDER: OAuthProvider = {
  id: "gdrive",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  clientId: process.env.GOOGLE_CLIENT_ID || "PLACEHOLDER_GOOGLE_CLIENT_ID",
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || "PLACEHOLDER_GOOGLE_CLIENT_SECRET",
  scope: [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/userinfo.email",
  ].join(" "),
  extraAuthParams: { access_type: "offline", prompt: "consent" },
};

/** base64url encoding (no padding), per RFC 7636. */
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A PKCE verifier/challenge pair (S256). */
export interface Pkce {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** Generate a PKCE code_verifier and its S256 code_challenge. */
export function generatePkce(): Pkce {
  const verifier = base64url(randomBytes(32)); // 43 chars, within RFC length bounds
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

/** A random state value for CSRF protection on the authorize request. */
export function generateState(): string {
  return base64url(randomBytes(16));
}
