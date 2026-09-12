import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type KeyboardEvent } from "react";
import type { FsEntry, FsListing } from "../shared/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { PromptDialog } from "./PromptDialog";
import { UpArrowIcon, ReloadIcon, NewFolderIcon, RenameIcon, TrashIcon, FolderEntryIcon, FileEntryIcon, SymlinkEntryIcon, TreeIcon } from "./Icons";
import { DirTree } from "./DirTree";

/** Filesystem operations for one side (local or remote), injected by the app so
 *  the pane is side-agnostic. Paths are POSIX for remote and native for local. */
export interface PaneOps {
  list(path: string): Promise<FsListing>;
  rename(fromPath: string, toName: string): Promise<void>;
  mkdir(parentPath: string, name: string): Promise<void>;
  delete(path: string): Promise<void>;
  /** Path separator for this side ("/" remote; provided for local). */
  sep: string;
}

interface Props {
  title: string;
  ops: PaneOps;
  initialPath: string;
  onError: (msg: string) => void;
  /** Which side this pane represents. */
  side: "local" | "remote";
  /** The other side is available as a transfer target (a session is connected). */
  transferEnabled: boolean;
  /** Label for the transfer button (e.g. "Upload →" on local, "↓ Download" on remote). */
  transferLabel: string;
  /** Enqueue a transfer of these entries from THIS pane's path to the other side. */
  onTransfer: (fromSide: "local" | "remote", fromDir: string, entries: FsEntry[]) => void;
  /** Notify the app of this pane's current directory (so the app knows the
   *  opposite pane's destination when a drop/transfer happens). */
  onPathChange?: (side: "local" | "remote", path: string) => void;
  /** Bump to force a re-list of the current directory (e.g. after a transfer). */
  reloadKey?: number;
  /** Show dotfiles (names starting with "."). When false they're hidden. */
  showHidden: boolean;
  /** Where directories sort relative to files. */
  directorySort: "top" | "inline" | "bottom";
}

function fmtSize(bytes: number, kind: FsEntry["kind"]): string {
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
  return ms ? new Date(ms).toLocaleString() : "";
}

/** The line-drawing icon for a directory entry, colored by kind. */
function EntryIcon({ kind }: { kind: FsEntry["kind"] }) {
  if (kind === "directory") return <span className="entry-icon dir"><FolderEntryIcon /></span>;
  if (kind === "symlink") return <span className="entry-icon link"><SymlinkEntryIcon /></span>;
  return <span className="entry-icon"><FileEntryIcon /></span>;
}

/** Join a path with a child segment using the pane's separator. */
function joinPath(base: string, child: string, sep: string): string {
  if (child === "..") {
    const trimmed = base.replace(new RegExp(`${sep === "\\" ? "\\\\" : sep}+$`), "");
    const idx = trimmed.lastIndexOf(sep);
    if (idx < 0) return base;
    const up = trimmed.slice(0, idx);
    // Preserve root ("/" for POSIX, "C:\" for Windows drive roots).
    if (up === "") return sep === "/" ? "/" : trimmed.slice(0, idx + 1);
    return up;
  }
  return base.replace(new RegExp(`${sep === "\\" ? "\\\\" : sep}+$`), "") + sep + child;
}

/** True when `target` is `base` itself or a descendant of it. Used to decide
 *  whether the directory tree (rooted at `base`) still contains the current
 *  directory, or whether it must be re-based higher. */
function isWithin(base: string, target: string, sep: string): boolean {
  const norm = (p: string) => {
    const t = p.replace(new RegExp(`${sep === "\\" ? "\\\\" : sep}+$`), "");
    return t === "" ? sep : t; // keep root as the separator
  };
  const b = norm(base);
  const t = norm(target);
  if (b === t) return true;
  // Descendant check: target starts with base + separator (root handled specially).
  const prefix = b === sep ? sep : b + sep;
  return t.startsWith(prefix);
}

/** A directory view (local or remote) with navigate, refresh, new folder,
 *  rename, and delete (with confirmation). */
export function FilePane({ title, ops, initialPath, onError, side, transferEnabled, transferLabel, onTransfer, onPathChange, reloadKey, showHidden, directorySort }: Props) {
  const [path, setPath] = useState(initialPath);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastClicked, setLastClicked] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<FsEntry | null>(null);
  const [deleting, setDeleting] = useState<FsEntry[] | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // Width (px) of the resizable Name column.
  const [nameWidth, setNameWidth] = useState(260);
  // Directory-tree viewer: visibility + the root path it's anchored at.
  const [treeVisible, setTreeVisible] = useState(false);
  const [treeRoot, setTreeRoot] = useState(initialPath);
  // Height (px) of the directory-tree panel (resizable via the divider below it).
  const [treeHeight, setTreeHeight] = useState(200);
  const paneRef = useRef<HTMLDivElement>(null);
  const [sortKey, setSortKey] = useState<"name" | "size" | "modified">("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  // Type-to-select (typeahead): accumulate typed characters and jump to the
  // first matching entry. The buffer resets after a short idle.
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());
  const typeahead = useRef<{ buffer: string; timer: ReturnType<typeof setTimeout> | null }>({
    buffer: "",
    timer: null,
  });

  // Click a header: toggle direction if it's the current column, else switch to
  // it (ascending). Directories always group first regardless of sort.
  const clickHeader = (key: "name" | "size" | "modified") => {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  };

  const sortedEntries = useMemo(() => {
    const visible = showHidden ? entries : entries.filter((e) => !e.name.startsWith("."));
    // Directory grouping: top = dirs before files, bottom = dirs after files,
    // inline = no grouping (dirs sort with files by the active column).
    const dirRank = (e: FsEntry) => {
      if (directorySort === "inline") return 0;
      const isDir = e.kind === "directory";
      if (directorySort === "bottom") return isDir ? 1 : 0;
      return isDir ? 0 : 1; // "top"
    };
    const cmp = (a: FsEntry, b: FsEntry) => {
      const dw = dirRank(a) - dirRank(b);
      if (dw !== 0) return dw;
      let r = 0;
      if (sortKey === "name") r = a.name.localeCompare(b.name);
      else if (sortKey === "size") r = a.sizeBytes - b.sizeBytes;
      else r = a.modifiedMs - b.modifiedMs;
      if (r === 0) r = a.name.localeCompare(b.name); // stable tiebreak
      return sortDir === "asc" ? r : -r;
    };
    return [...visible].sort(cmp);
  }, [entries, sortKey, sortDir, showHidden, directorySort]);

  const sortMark = (key: "name" | "size" | "modified") =>
    key === sortKey ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  /** Drag the divider on the Name header to resize the Name column. */
  const startNameResize = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation(); // don't trigger the header's sort click
    const startX = e.clientX;
    const startW = nameWidth;
    const onMove = (ev: globalThis.MouseEvent) => {
      const w = Math.max(120, Math.min(700, startW + (ev.clientX - startX)));
      setNameWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
  };

  /** Drag the horizontal divider to resize the directory-tree panel height.
   *  Clamped so the file list below always keeps a usable minimum height. */
  const startTreeResize = (e: MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = treeHeight;
    // Leave room for the toolbar/path/divider (~110px) plus a 140px minimum
    // file list, so the divider and list can never be dragged off-screen.
    const paneH = paneRef.current?.clientHeight ?? 600;
    const maxTree = Math.max(80, paneH - 110 - 140);
    const onMove = (ev: globalThis.MouseEvent) => {
      const h = Math.max(80, Math.min(maxTree, startH + (ev.clientY - startY)));
      setTreeHeight(h);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "row-resize";
  };

  const load = useCallback(
    async (target: string) => {
      setLoading(true);
      try {
        const listing = await ops.list(target);
        setPath(listing.path);
        setEntries(listing.entries);
        setSelected(new Set());
        setLastClicked(null);
        onPathChange?.(side, listing.path);
      } catch (e) {
        onError(e instanceof Error ? e.message : "Could not list the directory.");
      } finally {
        setLoading(false);
      }
    },
    [ops, onError, onPathChange, side]
  );

  useEffect(() => {
    void load(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath]);

  // Re-list the CURRENT directory when the app bumps reloadKey (e.g. after a
  // transfer completes into this pane). Skips the initial render.
  const pathRef = useRef(path);
  pathRef.current = path;
  const firstReload = useRef(true);
  useEffect(() => {
    if (firstReload.current) {
      firstReload.current = false;
      return;
    }
    void load(pathRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  // Keep the directory tree rooted so it always contains the current directory.
  // If the user navigates ABOVE (or outside) the tree's current root — e.g. via
  // the parent-folder button past the original base — re-anchor the tree at the
  // current path so it re-bases instead of losing the location.
  useEffect(() => {
    if (!treeVisible) return;
    if (!isWithin(treeRoot, path, ops.sep)) {
      setTreeRoot(path);
    }
  }, [path, treeVisible, treeRoot, ops.sep]);

  const doRename = useCallback(
    async (entry: FsEntry, newName: string) => {
      setRenaming(null);
      if (newName === entry.name) return;
      try {
        await ops.rename(joinPath(path, entry.name, ops.sep), newName);
        await load(path);
      } catch (e) {
        onError(e instanceof Error ? e.message : "Rename failed.");
      }
    },
    [ops, path, load, onError]
  );

  const doDelete = useCallback(
    async (targets: FsEntry[]) => {
      setDeleting(null);
      try {
        for (const entry of targets) {
          await ops.delete(joinPath(path, entry.name, ops.sep));
        }
        await load(path);
      } catch (e) {
        onError(e instanceof Error ? e.message : "Delete failed.");
      }
    },
    [ops, path, load, onError]
  );

  const doMkdir = useCallback(
    async (name: string) => {
      setNewFolder(false);
      try {
        await ops.mkdir(path, name);
        await load(path);
      } catch (e) {
        onError(e instanceof Error ? e.message : "Could not create the folder.");
      }
    },
    [ops, path, load, onError]
  );

  // Entries currently selected (in display order). selectedEntry is the single
  // selection (or null when zero/many) — used for single-target Rename.
  const selectedEntries = sortedEntries.filter((e) => selected.has(e.name));
  const selectedEntry = selectedEntries.length === 1 ? selectedEntries[0] : null;
  const hasSelection = selected.size > 0;

  /** Row click with modifier support: plain = single-select; Cmd/Ctrl = toggle;
   *  Shift = range from the last clicked row (in the current sorted order). */
  const onRowClick = (e: MouseEvent, name: string) => {
    const names = sortedEntries.map((x) => x.name);
    if (e.shiftKey && lastClicked) {
      const a = names.indexOf(lastClicked);
      const b = names.indexOf(name);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const range = new Set(names.slice(lo, hi + 1));
        setSelected(range);
        return;
      }
    }
    if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
      setLastClicked(name);
      return;
    }
    setSelected(new Set([name]));
    setLastClicked(name);
  };

  /** Select a single entry by name and scroll it into view (used by typeahead). */
  const selectAndReveal = useCallback((name: string) => {
    setSelected(new Set([name]));
    setLastClicked(name);
    rowRefs.current.get(name)?.scrollIntoView({ block: "nearest" });
  }, []);

  /** Type-to-select: match the first entry whose name begins with the typed
   *  buffer (case-insensitive), in the current sorted order. Repeatedly typing
   *  the SAME letter cycles through entries starting with that letter. The buffer
   *  clears after ~800ms of no typing, or on Escape. */
  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Ignore modifier combos (let Cmd/Ctrl shortcuts through) and non-character keys.
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // Tab: move focus to the OTHER file-list pane (Shift+Tab does the same here,
    // since there are only two). Keeps keyboard users on the panes.
    if (e.key === "Tab") {
      const lists = Array.from(document.querySelectorAll<HTMLElement>(".pane-list"));
      if (lists.length > 1 && listRef.current) {
        e.preventDefault();
        const here = lists.indexOf(listRef.current);
        const other = lists[(here + 1) % lists.length];
        other?.focus();
      }
      return;
    }

    // Return/Enter: open the selected folder (navigate into it). Only when a
    // single directory is selected — matches double-click behavior.
    if (e.key === "Enter") {
      const chosen = sortedEntries.filter((x) => selected.has(x.name));
      if (chosen.length === 1 && chosen[0].kind === "directory") {
        e.preventDefault();
        void load(joinPath(path, chosen[0].name, ops.sep));
      }
      return;
    }

    if (e.key === "Escape") {
      typeahead.current.buffer = "";
      if (typeahead.current.timer) clearTimeout(typeahead.current.timer);
      return;
    }
    if (e.key === "Backspace") {
      e.preventDefault();
      typeahead.current.buffer = typeahead.current.buffer.slice(0, -1);
    } else if (e.key.length === 1) {
      // Printable single character (letters, digits, punctuation). Space is
      // allowed as a continuation but never as the first character.
      if (e.key === " " && typeahead.current.buffer === "") return;
      e.preventDefault();
      typeahead.current.buffer += e.key;
    } else {
      return; // arrows, tab, enter, function keys, etc. — not typeahead input
    }

    const names = sortedEntries.map((x) => x.name);
    if (names.length === 0) return;
    const buf = typeahead.current.buffer.toLowerCase();

    let matchIdx = -1;
    if (buf.length === 1) {
      // Single character: cycle from just after the current selection.
      const current = names.findIndex((n) => selected.has(n));
      const start = current >= 0 ? current + 1 : 0;
      for (let i = 0; i < names.length; i++) {
        const idx = (start + i) % names.length;
        if (names[idx].toLowerCase().startsWith(buf)) {
          matchIdx = idx;
          break;
        }
      }
    } else {
      matchIdx = names.findIndex((n) => n.toLowerCase().startsWith(buf));
    }
    if (matchIdx >= 0) selectAndReveal(names[matchIdx]);

    // Reset the buffer after a short idle.
    if (typeahead.current.timer) clearTimeout(typeahead.current.timer);
    typeahead.current.timer = setTimeout(() => {
      typeahead.current.buffer = "";
    }, 800);
  };

  // Clear any pending typeahead timer on unmount.
  useEffect(() => {
    return () => {
      if (typeahead.current.timer) clearTimeout(typeahead.current.timer);
    };
  }, []);
  return (
    <div
      ref={paneRef}
      className={"pane" + (dragOver ? " drag-over" : "")}
      onDragOver={(e) => {
        // Accept drops that originate from the OTHER pane.
        if (!transferEnabled) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        if (!transferEnabled) return;
        e.preventDefault();
        try {
          const raw = e.dataTransfer.getData("application/x-jaguar-entries");
          if (!raw) return;
          const payload = JSON.parse(raw) as { side: "local" | "remote"; dir: string; entries: FsEntry[] };
          // Only accept items dragged FROM the opposite side.
          if (payload.side === side) return;
          onTransfer(payload.side, payload.dir, payload.entries);
        } catch {
          /* ignore malformed drops */
        }
      }}
    >
      <div className="pane-toolbar">
        <span className="pane-title">{title}</span>
        <button
          className={"icon-btn" + (treeVisible ? " active" : "")}
          title="Toggle directory tree"
          aria-label="Toggle directory tree"
          aria-pressed={treeVisible}
          onClick={() => {
            setTreeVisible((v) => {
              if (!v) setTreeRoot(path); // anchor the tree at the current dir when opening
              return !v;
            });
          }}
        >
          <TreeIcon />
        </button>
        <button className="icon-btn" title="Parent folder" aria-label="Parent folder" onClick={() => void load(joinPath(path, "..", ops.sep))}>
          <UpArrowIcon />
        </button>
        <button className="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => void load(path)}>
          <ReloadIcon />
        </button>
        <button className="icon-btn" title="New folder" aria-label="New folder" onClick={() => setNewFolder(true)}>
          <NewFolderIcon />
        </button>
        <button className="icon-btn" title="Rename" aria-label="Rename" disabled={!selectedEntry} onClick={() => selectedEntry && setRenaming(selectedEntry)}>
          <RenameIcon />
        </button>
        <button className="icon-btn danger-text" title="Delete" aria-label="Delete" disabled={!hasSelection} onClick={() => hasSelection && setDeleting(selectedEntries)}>
          <TrashIcon />
        </button>
        {transferEnabled && (
          <button
            className="secondary transfer-btn"
            title="Transfer the selected item(s) to the other pane"
            disabled={!hasSelection}
            onClick={() => hasSelection && onTransfer(side, path, selectedEntries)}
          >
            {transferLabel}
            {selected.size > 1 ? ` (${selected.size})` : ""}
          </button>
        )}
      </div>
      <div className="pane-path" title={path}>{path}{loading ? "  (loading…)" : ""}</div>
      {treeVisible && (
        <>
          <div className="tree-panel" style={{ height: treeHeight }}>
            <DirTree
              key={`${treeRoot}:${showHidden}`}
              ops={{ list: ops.list, sep: ops.sep }}
              root={treeRoot}
              currentPath={path}
              onSelect={(p) => void load(p)}
              onError={onError}
              showHidden={showHidden}
            />
          </div>
          <div className="tree-divider" title="Drag to resize" onMouseDown={startTreeResize} />
        </>
      )}
      <div
        className="pane-list"
        ref={listRef}
        tabIndex={0}
        onKeyDown={onListKeyDown}
        aria-label="File list (type to select)"
      >
        <table className="file-table" style={{ tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: nameWidth }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 160 }} />
            <col style={{ width: 90 }} />
          </colgroup>
          <thead>
            <tr>
              <th className="sortable name-th" onClick={() => clickHeader("name")}>
                <span className="name-th-inner">
                  <span className="th-label">Name{sortMark("name")}</span>
                  <span
                    className="col-resizer"
                    title="Drag to resize"
                    onMouseDown={startNameResize}
                    onClick={(e) => e.stopPropagation()}
                  />
                </span>
              </th>
              <th className="num sortable" onClick={() => clickHeader("size")}>Size{sortMark("size")}</th>
              <th className="sortable" onClick={() => clickHeader("modified")}>Modified{sortMark("modified")}</th>
              <th>Perms</th>
            </tr>
          </thead>
          <tbody>
            {sortedEntries.length === 0 ? (
              <tr><td colSpan={4} className="empty">{loading ? "" : "Empty directory."}</td></tr>
            ) : (
              sortedEntries.map((e) => (
                <tr
                  key={e.name}
                  ref={(el) => {
                    if (el) rowRefs.current.set(e.name, el);
                    else rowRefs.current.delete(e.name);
                  }}
                  className={(e.kind === "directory" ? "row-dir" : "") + (selected.has(e.name) ? " selected" : "")}
                  draggable={transferEnabled}
                  onDragStart={(ev) => {
                    // Drag the whole selection if the grabbed row is part of it;
                    // otherwise select just this row and drag it.
                    let dragging: FsEntry[];
                    if (selected.has(e.name)) {
                      dragging = sortedEntries.filter((x) => selected.has(x.name));
                    } else {
                      setSelected(new Set([e.name]));
                      setLastClicked(e.name);
                      dragging = [e];
                    }
                    ev.dataTransfer.setData(
                      "application/x-jaguar-entries",
                      JSON.stringify({ side, dir: path, entries: dragging })
                    );
                    ev.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={(ev) => onRowClick(ev, e.name)}
                  onDoubleClick={() => {
                    if (e.kind === "directory") void load(joinPath(path, e.name, ops.sep));
                  }}
                >
                  <td>
                    <span className="entry-cell">
                      <EntryIcon kind={e.kind} />
                      <span className="entry-name" title={e.name}>{e.name}</span>
                    </span>
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

      {renaming && (
        <PromptDialog
          title={`Rename “${renaming.name}”`}
          label="New name"
          initialValue={renaming.name}
          confirmLabel="Rename"
          onConfirm={(v) => void doRename(renaming, v)}
          onCancel={() => setRenaming(null)}
        />
      )}
      {newFolder && (
        <PromptDialog
          title="New folder"
          label="Folder name"
          confirmLabel="Create"
          onConfirm={(v) => void doMkdir(v)}
          onCancel={() => setNewFolder(false)}
        />
      )}
      {deleting && deleting.length > 0 && (
        <ConfirmDialog
          title={
            deleting.length === 1 ? `Delete “${deleting[0].name}”?` : `Delete ${deleting.length} items?`
          }
          message={
            (deleting.length === 1
              ? deleting[0].kind === "directory"
                ? "This permanently deletes the folder and everything inside it."
                : "This permanently deletes the file."
              : `This permanently deletes the ${deleting.length} selected items (folders include their contents).`) +
            " This cannot be undone."
          }
          confirmLabel="Delete"
          danger
          onConfirm={() => void doDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
