// Local filesystem access (Electron main process) behind the same shape as the
// remote SFTP engine, so one pane component can drive both. Uses node:fs/promises.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, dirname, resolve, sep } from "node:path";
import type { FsEntry, FsListing } from "../../src/shared/types.js";

/** The user's home directory — the local pane's default start location. */
export function homePath(): string {
  return homedir();
}

function kindFromStats(s: { isDirectory(): boolean; isSymbolicLink(): boolean; isFile(): boolean }): FsEntry["kind"] {
  if (s.isSymbolicLink()) return "symlink";
  if (s.isDirectory()) return "directory";
  if (s.isFile()) return "file";
  return "other";
}

/** List a local directory into a sorted FsListing (dirs first, then name). */
export async function list(path: string): Promise<FsListing> {
  const target = path && path.length > 0 ? resolve(path) : homedir();
  const dirents = await fs.readdir(target, { withFileTypes: true });
  const entries: FsEntry[] = [];
  for (const d of dirents) {
    const full = join(target, d.name);
    let kind: FsEntry["kind"];
    let sizeBytes = 0;
    let modifiedMs = 0;
    let mode: number | null = null;
    try {
      // lstat so symlinks report as symlinks (don't follow); size/mtime from it.
      const st = await fs.lstat(full);
      kind = kindFromStats(st);
      sizeBytes = Number(st.size) || 0;
      modifiedMs = st.mtimeMs ? Math.round(st.mtimeMs) : 0;
      mode = typeof st.mode === "number" ? st.mode & 0o7777 : null;
    } catch {
      // Unreadable entry (permissions, broken link): still list it by dirent type.
      kind = d.isDirectory() ? "directory" : d.isSymbolicLink() ? "symlink" : "file";
    }
    entries.push({ name: d.name, kind, sizeBytes, modifiedMs, mode });
  }
  entries.sort((a, b) => {
    const ad = a.kind === "directory" ? 0 : 1;
    const bd = b.kind === "directory" ? 0 : 1;
    return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
  });
  return { path: target, entries };
}

/** Rename/move a local entry within the same directory (name change) or path. */
export async function rename(fromPath: string, toName: string): Promise<void> {
  const from = resolve(fromPath);
  // toName may be a bare name (rename in place) or a path (move).
  const to = isAbsolute(toName) ? toName : join(dirname(from), toName);
  await fs.rename(from, to);
}

/** Delete a local file or directory (recursive for directories). */
export async function remove(path: string): Promise<void> {
  const target = resolve(path);
  // Guard against deleting a filesystem root.
  if (target === sep || /^[A-Za-z]:\\?$/.test(target)) {
    throw new Error("Refusing to delete a filesystem root.");
  }
  await fs.rm(target, { recursive: true, force: false });
}

/** Create a new directory under the given parent. */
export async function mkdir(parentPath: string, name: string): Promise<void> {
  const dir = join(resolve(parentPath), name);
  await fs.mkdir(dir, { recursive: false });
}
