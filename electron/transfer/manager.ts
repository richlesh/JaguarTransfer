// Transfer manager (Electron main process). Owns the transfer queue: expands
// directories into files, runs files with bounded concurrency, aggregates
// progress, supports cancel/pause/resume, and streams TransferTask updates to
// the renderer via a callback (wired to webContents.send in main).

import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { dirname, join, basename } from "node:path";
import type { TransferRequest, TransferTask, TransferStatus } from "../../src/shared/types.js";
import { emaThroughput, etaSeconds } from "../../src/core/transferPlan.js";
import {
  downloadFile,
  uploadFile,
  ensureRemoteDir,
  readdirDetailed,
  localSize,
} from "../sftp/engine.js";

/** A flat file unit within a task (after directory expansion). */
interface FileUnit {
  source: string;
  dest: string;
  sizeBytes: number;
  done: number;
  completed: boolean;
}

interface Task {
  id: string;
  sessionId: string;
  direction: "upload" | "download";
  name: string;
  sourcePath: string;
  destPath: string;
  status: TransferStatus;
  files: FileUnit[];
  planned: boolean;
  error?: string;
  // throughput tracking
  bytesPerSec: number;
  lastSampleMs: number;
  lastSampleBytes: number;
  // cooperative control
  cancelRequested: boolean;
  pauseRequested: boolean;
}

type Emit = (task: TransferTask) => void;

const tasks = new Map<string, Task>();
let emit: Emit = () => {};
let maxConcurrentFiles = 4;

export function configureManager(opts: { emit: Emit; maxConcurrentFiles?: number }): void {
  emit = opts.emit;
  if (opts.maxConcurrentFiles && opts.maxConcurrentFiles > 0) maxConcurrentFiles = opts.maxConcurrentFiles;
}

function toPublic(t: Task): TransferTask {
  const totalBytes = t.files.reduce((s, f) => s + f.sizeBytes, 0);
  const transferredBytes = t.files.reduce((s, f) => s + Math.min(f.done, f.sizeBytes), 0);
  const filesDone = t.files.filter((f) => f.completed).length;
  return {
    id: t.id,
    direction: t.direction,
    name: t.name,
    sourcePath: t.sourcePath,
    destPath: t.destPath,
    status: t.status,
    totalBytes,
    transferredBytes,
    fileCount: t.files.length,
    filesDone,
    bytesPerSec: t.status === "running" ? t.bytesPerSec : 0,
    etaSeconds: t.status === "running" ? etaSeconds(totalBytes, transferredBytes, t.bytesPerSec) : null,
    error: t.error,
  };
}

function publish(t: Task): void {
  emit(toPublic(t));
}

/** Recompute throughput EMA from cumulative transferred bytes. */
function sampleThroughput(t: Task): void {
  const now = Date.now();
  const transferred = t.files.reduce((s, f) => s + Math.min(f.done, f.sizeBytes), 0);
  const elapsed = now - t.lastSampleMs;
  if (elapsed >= 250) {
    const delta = transferred - t.lastSampleBytes;
    t.bytesPerSec = emaThroughput(t.bytesPerSec, delta, elapsed);
    t.lastSampleMs = now;
    t.lastSampleBytes = transferred;
  }
}

/** Expand a directory (recursively) into file units under destDir/name. */
async function expandDownloadDir(sessionId: string, remoteDir: string, localDestDir: string, files: FileUnit[]): Promise<void> {
  const children = await readdirDetailed(sessionId, remoteDir);
  for (const c of children) {
    if (c.isSymlink) continue; // skip symlinks in M3
    const src = remoteDir.replace(/\/+$/, "") + "/" + c.name;
    const dest = join(localDestDir, c.name);
    if (c.isDirectory) {
      await fsp.mkdir(dest, { recursive: true });
      await expandDownloadDir(sessionId, src, dest, files);
    } else {
      files.push({ source: src, dest, sizeBytes: c.sizeBytes, done: 0, completed: false });
    }
  }
}

async function expandUploadDir(sessionId: string, localDir: string, remoteDestDir: string, files: FileUnit[]): Promise<void> {
  await ensureRemoteDir(sessionId, remoteDestDir);
  const dirents = await fsp.readdir(localDir, { withFileTypes: true });
  for (const d of dirents) {
    if (d.isSymbolicLink()) continue; // skip symlinks in M3
    const src = join(localDir, d.name);
    const dest = remoteDestDir.replace(/\/+$/, "") + "/" + d.name;
    if (d.isDirectory()) {
      await expandUploadDir(sessionId, src, dest, files);
    } else {
      const size = await localSize(src);
      files.push({ source: src, dest, sizeBytes: size, done: 0, completed: false });
    }
  }
}

/** Build the file list for a task (sizing + directory expansion). */
async function planTask(t: Task, req: TransferRequest): Promise<void> {
  const files: FileUnit[] = [];
  if (req.direction === "download") {
    if (req.isDirectory) {
      const localDestDir = join(req.destDir, req.name);
      await fsp.mkdir(localDestDir, { recursive: true });
      await expandDownloadDir(req.sessionId, req.sourcePath, localDestDir, files);
    } else {
      files.push({ source: req.sourcePath, dest: join(req.destDir, req.name), sizeBytes: 0, done: 0, completed: false });
      // Size a single remote file via a 1-entry readdir of its parent.
      try {
        const parent = req.sourcePath.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
        const kids = await readdirDetailed(req.sessionId, parent);
        const me = kids.find((k) => k.name === basename(req.sourcePath));
        if (me) files[0].sizeBytes = me.sizeBytes;
      } catch {
        // leave size 0; progress still tracks bytes moved
      }
    }
  } else {
    if (req.isDirectory) {
      const remoteDestDir = req.destDir.replace(/\/+$/, "") + "/" + req.name;
      await expandUploadDir(req.sessionId, req.sourcePath, remoteDestDir, files);
    } else {
      const size = await localSize(req.sourcePath);
      files.push({
        source: req.sourcePath,
        dest: req.destDir.replace(/\/+$/, "") + "/" + req.name,
        sizeBytes: size,
        done: 0,
        completed: false,
      });
    }
  }
  t.files = files;
  t.planned = true;
}

/** Transfer a single file unit, wiring cumulative-byte progress. */
async function runFile(t: Task, f: FileUnit): Promise<void> {
  const onBytes = (transferred: number) => {
    f.done = transferred;
    sampleThroughput(t);
    publish(t);
  };
  if (t.direction === "download") {
    await fsp.mkdir(dirname(f.dest), { recursive: true });
    await downloadFile(t.sessionId, f.source, f.dest, onBytes);
  } else {
    await ensureRemoteDir(t.sessionId, dirname(f.dest).split(/[\\/]/).join("/"));
    await uploadFile(t.sessionId, f.source, f.dest, onBytes);
  }
  f.done = f.sizeBytes;
  f.completed = true;
  publish(t);
}

/** Run a task's files with bounded concurrency, honoring cancel/pause. */
async function runTask(t: Task): Promise<void> {
  t.status = "running";
  t.lastSampleMs = Date.now();
  t.lastSampleBytes = 0;
  publish(t);

  const pending = t.files.filter((f) => !f.completed);
  let index = 0;
  const worker = async (): Promise<void> => {
    while (index < pending.length) {
      if (t.cancelRequested) return;
      if (t.pauseRequested) {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      const f = pending[index++];
      await runFile(t, f);
    }
  };

  const workerCount = Math.max(1, Math.min(maxConcurrentFiles, pending.length || 1));
  try {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (t.cancelRequested) {
      t.status = "canceled";
    } else if (t.pauseRequested) {
      t.status = "paused";
    } else {
      t.status = "completed";
    }
  } catch (e) {
    t.status = "error";
    t.error = e instanceof Error ? e.message : String(e);
  }
  publish(t);
}

/** Enqueue and start a transfer. Returns the task id. */
export async function enqueue(req: TransferRequest): Promise<string> {
  const id = randomUUID();
  const destPath =
    req.direction === "download"
      ? join(req.destDir, req.name)
      : req.destDir.replace(/\/+$/, "") + "/" + req.name;
  const t: Task = {
    id,
    sessionId: req.sessionId,
    direction: req.direction,
    name: req.name,
    sourcePath: req.sourcePath,
    destPath,
    status: "queued",
    files: [],
    planned: false,
    bytesPerSec: 0,
    lastSampleMs: 0,
    lastSampleBytes: 0,
    cancelRequested: false,
    pauseRequested: false,
  };
  tasks.set(id, t);
  publish(t);

  // Plan + run asynchronously; errors surface on the task.
  (async () => {
    try {
      await planTask(t, req);
      publish(t);
      if (!t.cancelRequested) await runTask(t);
    } catch (e) {
      t.status = "error";
      t.error = e instanceof Error ? e.message : String(e);
      publish(t);
    }
  })();

  return id;
}

export function cancel(id: string): void {
  const t = tasks.get(id);
  if (!t) return;
  t.cancelRequested = true;
  if (t.status === "queued") {
    t.status = "canceled";
    publish(t);
  }
}

export function pause(id: string): void {
  const t = tasks.get(id);
  if (!t || t.status !== "running") return;
  t.pauseRequested = true;
}

export function resume(id: string): void {
  const t = tasks.get(id);
  if (!t) return;
  if (t.status === "paused") {
    t.pauseRequested = false;
    void runTask(t);
  }
}

export function listTasks(): TransferTask[] {
  return [...tasks.values()].map(toPublic);
}

/** Drop finished tasks from memory (Clear completed). */
export function clearFinished(): void {
  for (const [id, t] of [...tasks.entries()]) {
    if (t.status === "completed" || t.status === "canceled" || t.status === "error") tasks.delete(id);
  }
}
