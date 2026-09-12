// Post-build OAuth credential injection.
//
// provider.ts ships with PLACEHOLDER_* client IDs/secret and reads
// `process.env.X || "PLACEHOLDER_..."`. Because process.env isn't available on an
// end user's machine, the placeholders would remain in a packaged build. This
// script bakes the real values (from CI env / GitHub secrets) into the COMPILED
// output after `npm run build`, replacing the placeholder string literals.
//
// It's a no-op for any credential whose env var isn't set, so local dev builds
// (which rely on the developer's own env vars at runtime) are unaffected, and
// the committed source never contains secrets.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const providerJs = join(__dirname, "..", "dist-electron", "electron", "oauth", "provider.js");

if (!existsSync(providerJs)) {
  console.error(`inject-oauth: compiled provider not found at ${providerJs}. Run "npm run build" first.`);
  process.exit(1);
}

/** placeholder literal → env var that supplies the real value */
const SUBS = [
  { placeholder: "PLACEHOLDER_DROPBOX_CLIENT_ID", env: "DROPBOX_CLIENT_ID" },
  { placeholder: "PLACEHOLDER_ONEDRIVE_CLIENT_ID", env: "ONEDRIVE_CLIENT_ID" },
  { placeholder: "PLACEHOLDER_GOOGLE_CLIENT_ID", env: "GOOGLE_CLIENT_ID" },
  { placeholder: "PLACEHOLDER_GOOGLE_CLIENT_SECRET", env: "GOOGLE_CLIENT_SECRET" },
];

let source = readFileSync(providerJs, "utf8");
let replaced = 0;
const summary = [];

for (const { placeholder, env } of SUBS) {
  const value = process.env[env];
  if (!value) {
    summary.push(`${env}: (not set — left as placeholder)`);
    continue;
  }
  if (!source.includes(placeholder)) {
    summary.push(`${env}: env set but placeholder "${placeholder}" not found in output`);
    continue;
  }
  // Replace the placeholder literal everywhere it appears in the compiled JS.
  source = source.split(placeholder).join(value);
  replaced++;
  summary.push(`${env}: injected`);
}

writeFileSync(providerJs, source, "utf8");
console.log(`inject-oauth: ${replaced} credential(s) injected into provider.js`);
for (const line of summary) console.log(`  - ${line}`);
