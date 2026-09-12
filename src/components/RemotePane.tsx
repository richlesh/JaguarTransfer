import { useCallback, useEffect, useState } from "react";
import type { RemoteEntry } from "../shared/types";

interface Props {
  sessionId: string;
  initialPath: string;
  onError: (msg: string) => void;
}

function fmtSize(bytes: number, kind: RemoteEntry["kind"]): string {
  if (kind === "directory") return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function fmtMode(mode: number | null): string {
  if (mode == null) return "";
  const rwx = (n: number) => `${n & 4 ? "r" : "-"}${n & 2 ? "w" : "-"}${n & 1 ? "x" : "-"}`;
  return rwx((mode >> 6) & 7) + rwx((mode >> 3) & 7) + rwx(mode & 7);
}

function fmtDate(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString();
}

/** Join a base path with a child segment (POSIX). */
function joinPath(base: string, child: string): string {
  if (child === "..") {
    const trimmed = base.replace(/\/+$/, "");
    const idx = trimmed.lastIndexOf("/");
    return idx <= 0 ? "/" : trimmed.slice(0, idx);
  }
  return base.replace(/\/+$/, "") + "/" + child;
}

/** A single remote directory view with breadcrumb, up, and refresh. */
export function RemotePane({ sessionId, initialPath, onError }: Props) {
  const [path, setPath] = useState(initialPath);
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (target: string) => {
      setLoading(true);
      try {
        const listing = await window.jaguar.remoteList(sessionId, target);
        setPath(listing.path);
        setEntries(listing.entries);
      } catch (e) {
        onError(e instanceof Error ? e.message : "Could not list the directory.");
      } finally {
        setLoading(false);
      }
    },
    [sessionId, onError]
  );

  useEffect(() => {
    void load(initialPath);
  }, [load, initialPath]);

  return (
    <div className="pane">
      <div className="pane-toolbar">
        <button className="secondary" title="Up one level" onClick={() => void load(joinPath(path, ".."))}>↑</button>
        <button className="secondary" title="Refresh" onClick={() => void load(path)}>⟳</button>
        <span className="pane-path" title={path}>{path}</span>
        {loading && <span className="muted">loading…</span>}
      </div>
      <div className="pane-list">
        <table className="file-table">
          <thead>
            <tr>
              <th>Name</th>
              <th className="num">Size</th>
              <th>Modified</th>
              <th>Perms</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr><td colSpan={4} className="empty">{loading ? "" : "Empty directory."}</td></tr>
            ) : (
              entries.map((e) => (
                <tr
                  key={e.name}
                  className={e.kind === "directory" ? "row-dir" : ""}
                  onDoubleClick={() => {
                    if (e.kind === "directory") void load(joinPath(path, e.name));
                  }}
                >
                  <td>
                    <span className="entry-icon">{e.kind === "directory" ? "📁" : e.kind === "symlink" ? "🔗" : "📄"}</span>
                    {e.name}
                  </td>
                  <td className="num">{fmtSize(e.sizeBytes, e.kind)}</td>
                  <td>{fmtDate(e.modifiedMs)}</td>
                  <td className="perms">{fmtMode(e.mode)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
