// Loopback redirect server for the OAuth Authorization Code flow (Electron main).
//
// We start a short-lived HTTP server on 127.0.0.1 with an ephemeral port, use it
// as the redirect URI, and resolve once the provider redirects back with the
// authorization code (validating the CSRF state). The server always shuts down.

import { createServer, type Server } from "node:http";

export interface LoopbackResult {
  code: string;
  redirectUri: string;
}

export interface LoopbackHandle {
  /** The redirect URI to hand to the authorize request (http://127.0.0.1:PORT/). */
  redirectUri: string;
  /** Resolves with the auth code once the provider redirects back. */
  waitForCode(expectedState: string): Promise<string>;
  /** Tear down the server (safe to call multiple times). */
  close(): void;
}

/** The fixed loopback port used for the OAuth redirect. It must be registered
 *  verbatim as a redirect URI on the provider (e.g. Dropbox does exact matching
 *  of scheme+host+port+path), so it can't be random. */
export const LOOPBACK_PORT = 53682;
/** The exact redirect URI to register on the provider AND send in the flow. */
export const LOOPBACK_REDIRECT_URI = `http://localhost:${LOOPBACK_PORT}/`;

/** Start the loopback server on the fixed port and return its redirect URI + a
 *  code waiter. Rejects if the port is already in use. */
export function startLoopbackServer(): Promise<LoopbackHandle> {
  return new Promise((resolve, reject) => {
    let resolveCode: ((code: string) => void) | null = null;
    let rejectCode: ((err: Error) => void) | null = null;
    let expected: string | null = null;

    const server: Server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", LOOPBACK_REDIRECT_URI);
        // Ignore favicon or other stray requests until we get the callback.
        if (!url.searchParams.has("code") && !url.searchParams.has("error")) {
          res.writeHead(204);
          res.end();
          return;
        }
        const err = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        const finish = (ok: boolean, message: string) => {
          res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            `<!doctype html><html><head><meta charset="utf-8"><title>TransferJaguar</title>` +
              `<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;` +
              `display:flex;height:100vh;align-items:center;justify-content:center;margin:0}` +
              `.card{text-align:center;padding:32px}</style></head><body><div class="card">` +
              `<h2>${ok ? "Connected \u2713" : "Connection failed"}</h2>` +
              `<p>${message}</p><p>You can close this window and return to TransferJaguar.</p>` +
              `</div></body></html>`
          );
        };

        if (err) {
          finish(false, `Authorization was denied (${err}).`);
          rejectCode?.(new Error(`Authorization denied: ${err}`));
          return;
        }
        if (!code) {
          finish(false, "No authorization code was returned.");
          rejectCode?.(new Error("No authorization code returned."));
          return;
        }
        if (expected != null && state !== expected) {
          finish(false, "State mismatch (possible CSRF); aborted.");
          rejectCode?.(new Error("OAuth state mismatch (possible CSRF)."));
          return;
        }
        finish(true, "Authorization complete.");
        resolveCode?.(code);
      } catch (e) {
        rejectCode?.(e instanceof Error ? e : new Error(String(e)));
      }
    });

    server.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE") {
        reject(
          new Error(
            `The OAuth redirect port ${LOOPBACK_PORT} is in use. Close whatever is using it and try again.`
          )
        );
      } else {
        reject(e);
      }
    });

    // Bind the FIXED port on loopback (both localhost and 127.0.0.1 resolve here).
    server.listen(LOOPBACK_PORT, "127.0.0.1", () => {
      const redirectUri = LOOPBACK_REDIRECT_URI;

      const close = () => {
        try { server.close(); } catch { /* noop */ }
      };

      resolve({
        redirectUri,
        close,
        waitForCode(expectedState: string) {
          expected = expectedState;
          return new Promise<string>((res, rej) => {
            resolveCode = (c) => { res(c); close(); };
            rejectCode = (e) => { rej(e); close(); };
            // Safety timeout: don't leave the server (and flow) open forever.
            setTimeout(() => {
              rej(new Error("Timed out waiting for authorization (5 min)."));
              close();
            }, 5 * 60 * 1000);
          });
        },
      });
    });
  });
}
