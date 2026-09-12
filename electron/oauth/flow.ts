// OAuth 2.0 Authorization Code + PKCE flow (Electron main process).
//
// runConsentFlow opens the provider's consent screen in a dedicated, isolated
// BrowserWindow, captures the redirect via a loopback server, and exchanges the
// code for tokens. refreshTokens renews an access token using a refresh token.
// No client secret is used (public desktop client).

import { BrowserWindow } from "electron";
import type { OAuthProvider, Pkce } from "./provider.js";
import { generatePkce, generateState } from "./provider.js";
import { startLoopbackServer } from "./loopback.js";

/** A provider's client secret, unless it's still the unfilled placeholder. */
function usableSecret(provider: OAuthProvider): string | undefined {
  const s = provider.clientSecret;
  return s && !s.startsWith("PLACEHOLDER_") ? s : undefined;
}

/** Tokens as returned/normalized from the provider. */
export interface OAuthTokens {
  accessToken: string;
  /** Absent if the provider didn't issue one (we request offline access). */
  refreshToken?: string;
  /** Epoch ms when the access token expires (0 if unknown). */
  expiresAtMs: number;
  scope?: string;
  tokenType?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

function toTokens(r: TokenResponse, fallbackRefresh?: string): OAuthTokens {
  const expiresInMs = typeof r.expires_in === "number" ? r.expires_in * 1000 : 0;
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token ?? fallbackRefresh,
    expiresAtMs: expiresInMs ? Date.now() + expiresInMs : 0,
    scope: r.scope,
    tokenType: r.token_type,
  };
}

/** POST form-encoded params to the token endpoint. */
async function postToken(provider: OAuthProvider, params: Record<string, string>): Promise<TokenResponse> {
  const body = new URLSearchParams(params).toString();
  const resp = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await resp.json().catch(() => ({}))) as TokenResponse;
  if (!resp.ok || json.error) {
    throw new Error(json.error_description || json.error || `Token request failed (HTTP ${resp.status}).`);
  }
  return json;
}

/** Build the authorize URL with PKCE + state + loopback redirect. */
function authorizeUrl(provider: OAuthProvider, pkce: Pkce, state: string, redirectUri: string): string {
  const u = new URL(provider.authorizeUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", provider.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", provider.scope);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", pkce.challenge);
  u.searchParams.set("code_challenge_method", pkce.method);
  for (const [k, v] of Object.entries(provider.extraAuthParams ?? {})) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * Run the interactive consent flow: open the provider's consent screen in an
 * isolated window, capture the authorization code via the loopback server, and
 * exchange it (with the PKCE verifier) for tokens.
 */
export async function runConsentFlow(provider: OAuthProvider, parent?: BrowserWindow): Promise<OAuthTokens> {
  const pkce = generatePkce();
  const state = generateState();
  const loop = await startLoopbackServer();

  const authUrl = authorizeUrl(provider, pkce, state, loop.redirectUri);

  // Isolated consent window: no node integration, no preload, no access to the
  // app. It only loads the provider's HTTPS consent page.
  const authWin = new BrowserWindow({
    width: 520,
    height: 680,
    title: "Authorize",
    autoHideMenuBar: true,
    parent,
    modal: !!parent,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: `oauth:${provider.id}:${Date.now()}`, // ephemeral, don't persist provider cookies
    },
  });

  let settled = false;
  const cleanup = () => {
    loop.close();
    if (!authWin.isDestroyed()) authWin.close();
  };

  try {
    const codePromise = loop.waitForCode(state);
    await authWin.loadURL(authUrl);

    // If the user closes the window before completing, reject.
    const closedPromise = new Promise<never>((_, rej) => {
      authWin.on("closed", () => {
        if (!settled) rej(new Error("Authorization window was closed before completing."));
      });
    });

    const code = await Promise.race([codePromise, closedPromise]);
    settled = true;

    const exchangeParams: Record<string, string> = {
      grant_type: "authorization_code",
      code,
      client_id: provider.clientId,
      redirect_uri: loop.redirectUri,
      code_verifier: pkce.verifier,
    };
    const exSecret = usableSecret(provider);
    if (exSecret) exchangeParams.client_secret = exSecret;
    const tokenResp = await postToken(provider, exchangeParams);
    return toTokens(tokenResp);
  } finally {
    settled = true;
    cleanup();
  }
}

/** Exchange a refresh token for a fresh access token. */
export async function refreshTokens(provider: OAuthProvider, refreshToken: string): Promise<OAuthTokens> {
  const params: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: provider.clientId,
  };
  const secret = usableSecret(provider);
  if (secret) params.client_secret = secret;
  const resp = await postToken(provider, params);
  // Providers often omit refresh_token on refresh; keep the existing one.
  return toTokens(resp, refreshToken);
}
