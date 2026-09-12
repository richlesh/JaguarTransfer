import type { TransferTask } from "../shared/types";
import { percent } from "../core/transferPlan";

interface Props {
  tasks: TransferTask[];
  onCancel: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onClearFinished: () => void;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function fmtRate(bps: number): string {
  return bps > 0 ? `${fmtBytes(bps)}/s` : "";
}

function fmtEta(sec: number | null): string {
  if (sec == null) return "";
  if (sec < 1) return "<1s";
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const STATUS_LABEL: Record<TransferTask["status"], string> = {
  queued: "Queued",
  running: "Running",
  paused: "Paused",
  completed: "Done",
  canceled: "Canceled",
  error: "Error",
};

/** The transfer queue: one row per task with progress, throughput, ETA, and
 *  per-task controls (pause/resume/cancel). */
export function TransferQueue({ tasks, onCancel, onPause, onResume, onClearFinished }: Props) {
  const active = tasks.filter((t) => t.status === "running" || t.status === "queued" || t.status === "paused").length;
  return (
    <div className="queue">
      <div className="queue-head">
        <strong>Transfers</strong>
        {active > 0 && <span className="muted">{active} active</span>}
        <span style={{ flex: 1 }} />
        <button className="secondary" onClick={onClearFinished}>Clear finished</button>
      </div>
      <div className="queue-list">
        {tasks.length === 0 ? (
          <div className="empty">No transfers yet. Drag files between panes, or use Upload/Download.</div>
        ) : (
          tasks.map((t) => {
            const pct = percent(t.totalBytes, t.transferredBytes);
            const dir = t.direction === "upload" ? "↑" : "↓";
            return (
              <div key={t.id} className={"queue-item status-" + t.status}>
                <div className="queue-item-top">
                  <span className="queue-dir">{dir}</span>
                  <span className="queue-name" title={`${t.sourcePath} → ${t.destPath}`}>{t.name}</span>
                  <span className="queue-status">{STATUS_LABEL[t.status]}</span>
                  <span className="queue-controls">
                    {t.status === "running" && (
                      <button className="secondary tiny" onClick={() => onPause(t.id)}>Pause</button>
                    )}
                    {t.status === "paused" && (
                      <button className="secondary tiny" onClick={() => onResume(t.id)}>Resume</button>
                    )}
                    {(t.status === "running" || t.status === "queued" || t.status === "paused") && (
                      <button className="secondary tiny danger-text" onClick={() => onCancel(t.id)}>Cancel</button>
                    )}
                  </span>
                </div>
                <div className="progress">
                  <div className={"progress-bar " + t.status} style={{ width: `${pct}%` }} />
                </div>
                <div className="queue-item-meta">
                  <span>{pct}%</span>
                  <span>{fmtBytes(t.transferredBytes)} / {fmtBytes(t.totalBytes)}</span>
                  {t.fileCount > 1 && <span>{t.filesDone}/{t.fileCount} files</span>}
                  {t.status === "running" && <span>{fmtRate(t.bytesPerSec)}</span>}
                  {t.status === "running" && t.etaSeconds != null && <span>ETA {fmtEta(t.etaSeconds)}</span>}
                  {t.status === "error" && <span className="danger-text" title={t.error}>{t.error}</span>}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
