// Pure, framework-agnostic helpers for transfer planning and progress math.
// Kept free of Node/Electron/ssh2 imports so they can be unit-tested directly.

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
