// Writes a CommonJS type marker so dist-electron/*.js are loaded as CommonJS,
// even though the root package.json is "type": "module". JaguarTransfer has no
// other runtime assets to copy (unlike BudgetLion's schema.sql).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const marker = join(root, "dist-electron", "package.json");
mkdirSync(dirname(marker), { recursive: true });
writeFileSync(marker, JSON.stringify({ type: "commonjs" }) + "\n");
console.log("wrote dist-electron/package.json (type: commonjs)");
