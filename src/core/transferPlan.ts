// Pure, framework-agnostic helpers for transfer planning and progress math.
// Kept free of Node/Electron/ssh2 imports so they can be unit-tested directly.
import type { ConflictPolicy } from "../shared/types";

/** A flat file unit within a transfer task (after directory expansion). */
export interface PlannedFile {
  /** Absolute source path. */
  source: string;
  /** Absolute destination path. */
  dest: string;
  /** Size in bytes (0 if unknown until stat). */
  sizeBytes: number;
}

/** A remote/local directory tree node used by the expander (side-agnostic). */
export interface TreeNode {
  name: string;
  isDirectory: boolean;
  sizeBytes: number;
}

/**
 * Join two path segments with the given separator, avoiding duplicate seps.
 * Works for POSIX ("/") and Windows ("\\").
 */
export function joinWith(base: string, child: string, sep: string): string {
  const escSep = sep === "\\" ? "\\\\" : sep;
  return base.replace(new RegExp(`${escSep}+$`), "") + sep + child;
}

/**
 * Exponential moving average of throughput (bytes/sec). Given the previous EMA,
 * the bytes moved since the last sample, and the elapsed ms, returns the new EMA.
 * alpha in (0,1]; higher = more responsive. Returns 0 for non-positive elapsed.
 */
export function emaThroughput(prevBytesPerSec: number, deltaBytes: number, elapsedMs: number, alpha = 0.3): number {
  if (elapsedMs <= 0) return prevBytesPerSec;
  const instant = (deltaBytes * 1000) / elapsedMs;
  if (prevBytesPerSec <= 0) return instant;
  return alpha * instant + (1 - alpha) * prevBytesPerSec;
}

/** Estimated seconds remaining from bytes left and current throughput. */
export function etaSeconds(totalBytes: number, transferredBytes: number, bytesPerSec: number): number | null {
  if (bytesPerSec <= 0) return null;
  const remaining = Math.max(0, totalBytes - transferredBytes);
  if (remaining === 0) return 0;
  return remaining / bytesPerSec;
}

/** Percent complete (0–100), guarding divide-by-zero. */
export function percent(totalBytes: number, transferredBytes: number): number {
  if (totalBytes <= 0) return transferredBytes > 0 ? 100 : 0;
  return Math.min(100, Math.round((transferredBytes / totalBytes) * 1000) / 10);
}

/**
 * Aggregate per-file byte counts into a task total. `sizes[i]` is a file's total
 * size; `perFileDone[i]` is its transferred bytes. A file counts as done when its
 * transferred bytes reach its size (and it has a known positive size).
 */
export function aggregate(
  sizes: number[],
  perFileDone: number[]
): { totalBytes: number; transferredBytes: number; filesDone: number } {
  const totalBytes = sizes.reduce((s, n) => s + n, 0);
  let transferredBytes = 0;
  let filesDone = 0;
  for (let i = 0; i < sizes.length; i++) {
    const size = sizes[i];
    const done = Math.min(perFileDone[i] ?? 0, size);
    transferredBytes += done;
    if (size > 0 && done >= size) filesDone++;
  }
  return { totalBytes, transferredBytes, filesDone };
}

/**
 * Bounded-concurrency scheduler order: given N items and a concurrency limit,
 * returns the sequence of "waves" (arrays of item indices) that would run. This
 * is pure and used to unit-test the scheduling contract (not the async runner).
 */
export function scheduleWaves(itemCount: number, concurrency: number): number[][] {
  const c = Math.max(1, Math.floor(concurrency));
  const waves: number[][] = [];
  for (let i = 0; i < itemCount; i += c) {
    const wave: number[] = [];
    for (let j = i; j < Math.min(i + c, itemCount); j++) wave.push(j);
    waves.push(wave);
  }
  return waves;
}

/** Split a filename into its base and extension (extension includes the dot).
 *  Leading-dot names (dotfiles) are treated as having no extension. */
export function splitExt(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { base: name, ext: "" }; // no ext, or leading-dot dotfile
  return { base: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * Generate a unique name not present in `existing` by inserting " (n)" before
 * the extension: "file.txt" -> "file (1).txt", "file (2).txt", … Directories
 * (ext "") get "dir (1)". Returns the original name when it isn't taken.
 */
export function uniqueName(name: string, existing: Set<string>): string {
  if (!existing.has(name)) return name;
  const { base, ext } = splitExt(name);
  for (let n = 1; n < 100000; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})${ext}`; // pathological fallback
}

/** The action to take for one item given the policy and whether it exists. */
export type ConflictAction =
  | { action: "transfer"; name: string } // proceed (possibly renamed)
  | { action: "skip" };

/**
 * Resolve what to do for a destination item: if it doesn't already exist,
 * transfer under its own name; otherwise apply the policy — overwrite (same
 * name), skip, or rename (unique name derived from `existingNames`).
 */
export function resolveConflict(
  name: string,
  existingNames: Set<string>,
  policy: ConflictPolicy
): ConflictAction {
  if (!existingNames.has(name)) return { action: "transfer", name };
  if (policy === "skip") return { action: "skip" };
  if (policy === "rename") return { action: "transfer", name: uniqueName(name, existingNames) };
  return { action: "transfer", name }; // overwrite
}
