import { useCallback, useEffect, useMemo, useState } from "react";
import type { Site, HostKeyPrompt } from "./shared/types";
import type { AppSettings } from "./shared/ipc";
import { SiteEditorDialog } from "./components/SiteEditorDialog";
import { HostKeyDialog } from "./components/HostKeyDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ConflictDialog, type ConflictChoice } from "./components/ConflictDialog";
import { FilePane, type PaneOps } from "./components/FilePane";
import { TransferQueue } from "./components/TransferQueue";
import { SettingsIcon, PlusIcon, ConnectIcon, TrashIcon, RenameIcon } from "./components/Icons";

interface ActiveSession {
  sessionId: string;
  site: Site;
  cwd: string;
}

export function App() {
  const [sites, setSites] = useState<Site[]>([]);
  const [editing, setEditing] = useState<{ site: Site | null } | null>(null);
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [hostKey, setHostKey] = useState<{ site: Site; prompt: HostKeyPrompt } | null>(null);
  const [localHome, setLocalHome] = useState<string>("");
  const [toast, setToast] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [siteToDelete, setSiteToDelete] = useState<Site | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState<import("./shared/types").TransferTask | null>(null);
  const [tasks, setTasks] = useState<Map<string, import("./shared/types").TransferTask>>(new Map());
  const [paths, setPaths] = useState<{ local: string; remote: string }>({ local: "", remote: "" });

  // A transfer batch awaiting a conflict decision (policy "ask" + collisions).
  interface PendingBatch {
    direction: "upload" | "download";
    destDir: string;
    fromSep: string;
    fromDir: string;
    entries: import("./shared/types").FsEntry[];
    /** Names in the batch that already exist at the destination. */
    conflictNames: string[];
  }
  const [pendingBatch, setPendingBatch] = useState<PendingBatch | null>(null);

  const refreshSites = useCallback(async () => {
    setSites(await window.transferJaguar.listSites());
  }, []);

  // Subscribe to transfer progress; refresh the current task list on mount.
  useEffect(() => {
    void window.transferJaguar.transferList().then((list) => {
      setTasks(new Map(list.map((t) => [t.id, t])));
    });
    const unsub = window.transferJaguar.onTransferProgress((task) => {
      setTasks((prev) => {
        const next = new Map(prev);
        next.set(task.id, task);
        return next;
      });
    });
    return unsub;
  }, []);

  // Surface transient transfer notices (e.g. rsync fallback) as a toast.
  useEffect(() => {
    return window.transferJaguar.onTransferNotice((message) => setToast(message));
  }, []);

  // Open Settings when chosen from the native menu.
  useEffect(() => {
    return window.transferJaguar.onOpenSettings(() => setShowSettings(true));
  }, []);

  // Reflect SSH connection state (auto-reconnect) in a small banner + toast.
  const [connState, setConnState] = useState<"connected" | "reconnecting" | "disconnected" | null>(null);
  useEffect(() => {
    return window.transferJaguar.onConnectionState((ev) => {
      if (!session || ev.sessionId !== session.sessionId) return;
      setConnState(ev.state);
      if (ev.state === "reconnecting") setToast(`Connection lost — reconnecting… (${ev.detail ?? ""})`);
      else if (ev.state === "connected") setToast("Reconnected.");
      else if (ev.state === "disconnected") {
        setToast(`Disconnected${ev.detail ? ` — ${ev.detail}` : ""}.`);
        setSession(null);
      }
    });
  }, [session]);

  useEffect(() => {
    void refreshSites();
    void window.transferJaguar.localHome().then(setLocalHome);
    void window.transferJaguar.getSettings().then(setSettings);
  }, [refreshSites]);

  // Apply the theme to the document root whenever it changes.
  useEffect(() => {
    const dark = settings?.theme === "dark";
    document.body.classList.toggle("dark", dark);
  }, [settings?.theme]);

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    // Optimistic local update so the theme flips immediately, then persist.
    setSettings((prev) => ({ ...(prev ?? { theme: "light" }), ...patch }));
    const saved = await window.transferJaguar.saveSettings(patch);
    setSettings(saved);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const connect = useCallback(async (site: Site) => {
    setConnectingId(site.id);
    try {
      const res = await window.transferJaguar.connect(site.id);
      if (res.ok) {
        setSession({ sessionId: res.sessionId, site, cwd: res.cwd });
        setHostKey(null);
      } else if ("needsHostKeyTrust" in res && res.needsHostKeyTrust) {
        setHostKey({ site, prompt: res.prompt });
      } else if ("error" in res) {
        setToast(res.error);
      }
    } finally {
      setConnectingId(null);
    }
  }, []);

  const trustAndConnect = useCallback(async () => {
    if (!hostKey) return;
    const { site, prompt } = hostKey;
    await window.transferJaguar.hostkeyTrust(prompt);
    setHostKey(null);
    await connect(site);
  }, [hostKey, connect]);

  const disconnect = useCallback(async () => {
    if (!session) return;
    await window.transferJaguar.disconnect(session.sessionId);
    setSession(null);
  }, [session]);

  const removeSite = useCallback(
    async (site: Site) => {
      if (session?.site.id === site.id) await disconnect();
      await window.transferJaguar.deleteSite(site.id);
      await refreshSites();
    },
    [session, disconnect, refreshSites]
  );

  // Local pane ops: native path separator (matches the OS the app runs on).
  const localSep = navigator.platform.startsWith("Win") ? "\\" : "/";
  const localOps = useMemo<PaneOps>(
    () => ({
      list: (p) => window.transferJaguar.localList(p),
      rename: (from, toName) => window.transferJaguar.localRename(from, toName),
      mkdir: (parent, name) => window.transferJaguar.localMkdir(parent, name),
      delete: (p) => window.transferJaguar.localDelete(p),
      sep: localSep,
    }),
    [localSep]
  );

  // Remote pane ops: bound to the active session; POSIX paths.
  const remoteOps = useMemo<PaneOps | null>(() => {
    if (!session) return null;
    const sid = session.sessionId;
    return {
      list: (p) => window.transferJaguar.remoteList(sid, p),
      rename: (from, toName) => window.transferJaguar.remoteRename(sid, from, toName),
      mkdir: (parent, name) => window.transferJaguar.remoteMkdir(sid, parent, name),
      delete: (p) => window.transferJaguar.remoteDelete(sid, p),
      sep: "/",
    };
  }, [session]);

  const onPanePath = useCallback((s: "local" | "remote", p: string) => {
    setPaths((prev) => ({ ...prev, [s]: p }));
  }, []);

  /** Enqueue every entry of a batch with an already-resolved conflict policy
   *  ("overwrite" | "skip" | "rename"). Records one request gesture per batch. */
  const enqueueResolved = useCallback(
    async (
      direction: "upload" | "download",
      fromDir: string,
      fromSep: string,
      destDir: string,
      entries: import("./shared/types").FsEntry[],
      policy: "overwrite" | "skip" | "rename"
    ) => {
      if (!session || entries.length === 0) return;
      // One transfer request per user gesture (a multi-select counts as one).
      void window.transferJaguar.recordTransferRequest();
      for (const entry of entries) {
        const sourcePath =
          fromDir.replace(new RegExp(`${fromSep === "\\" ? "\\\\" : fromSep}+$`), "") + fromSep + entry.name;
        try {
          await window.transferJaguar.transferEnqueue({
            sessionId: session.sessionId,
            direction,
            sourcePath,
            destDir,
            name: entry.name,
            isDirectory: entry.kind === "directory",
            conflictPolicy: policy,
            verifyChecksum: !!settings?.verifyChecksum,
          });
        } catch (e) {
          setToast(e instanceof Error ? e.message : "Could not start the transfer.");
        }
      }
    },
    [session, settings]
  );

  /** Enqueue a transfer of `entries` from `fromSide`/`fromDir` to the opposite
   *  pane's current directory. When the conflict policy is "ask", check the
   *  destination for name collisions across the whole batch and, if any exist,
   *  show a single Replace / Keep both / Cancel prompt whose choice applies to
   *  every conflicting item (Cancel aborts the whole batch). */
  const enqueueTransfer = useCallback(
    async (fromSide: "local" | "remote", fromDir: string, entries: import("./shared/types").FsEntry[]) => {
      if (!session) {
        setToast("Connect to a site before transferring.");
        return;
      }
      const direction = fromSide === "local" ? "upload" : "download";
      const destDir = fromSide === "local" ? paths.remote : paths.local;
      if (!destDir) {
        setToast("Destination directory not ready yet.");
        return;
      }
      const fromSep = fromSide === "local" ? localSep : "/";
      if (entries.length === 0) return;

      const policy = settings?.conflictPolicy ?? "ask";
      if (policy !== "ask") {
        await enqueueResolved(direction, fromDir, fromSep, destDir, entries, policy);
        return;
      }

      // "ask": list the destination and find which batch names already exist.
      let existing: Set<string>;
      try {
        const listing =
          direction === "upload"
            ? await window.transferJaguar.remoteList(session.sessionId, destDir)
            : await window.transferJaguar.localList(destDir);
        existing = new Set(listing.entries.map((e) => e.name));
      } catch {
        // Can't read the destination (e.g. it doesn't exist yet) — no conflicts.
        existing = new Set();
      }
      const conflictNames = entries.filter((e) => existing.has(e.name)).map((e) => e.name);
      if (conflictNames.length === 0) {
        // Nothing collides; "rename" is a no-op here (each item keeps its name).
        await enqueueResolved(direction, fromDir, fromSep, destDir, entries, "rename");
        return;
      }
      // Defer to the user via the conflict dialog.
      setPendingBatch({ direction, destDir, fromSep, fromDir, entries, conflictNames });
    },
    [session, paths, localSep, settings, enqueueResolved]
  );

  /** Resolve the pending batch's conflict prompt. Cancel aborts the whole batch. */
  const resolvePendingBatch = useCallback(
    (choice: ConflictChoice) => {
      const batch = pendingBatch;
      setPendingBatch(null);
      if (!batch || choice === "cancel") return; // Cancel = abort the entire batch.
      // "overwrite" | "skip" | "rename" all map straight through: with "skip",
      // duplicate items are skipped while non-duplicates still transfer.
      void enqueueResolved(batch.direction, batch.fromDir, batch.fromSep, batch.destDir, batch.entries, choice);
    },
    [pendingBatch, enqueueResolved]
  );

  // When a task finishes, bump the destination pane's reload key so it re-lists.
  const prevStatuses = useMemo(() => new Map<string, string>(), []);
  const [localReload, setLocalReload] = useState(0);
  const [remoteReload, setRemoteReload] = useState(0);
  useEffect(() => {
    for (const t of tasks.values()) {
      const prev = prevStatuses.get(t.id);
      if (prev !== "completed" && t.status === "completed") {
        if (t.direction === "upload") setRemoteReload((k) => k + 1);
        else setLocalReload((k) => k + 1);
      }
      prevStatuses.set(t.id, t.status);
    }
  }, [tasks, prevStatuses]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <strong>Sites</strong>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" title="New site" aria-label="New site" onClick={() => setEditing({ site: null })}>
            <PlusIcon />
          </button>
        </div>
        <div className="site-list">
          {sites.length === 0 ? (
            <div className="empty">No sites yet. Add one to connect.</div>
          ) : (
            sites.map((s) => (
              <div key={s.id} className={"site-item" + (session?.site.id === s.id ? " active" : "")}>
                <div className="site-main" onDoubleClick={() => void connect(s)}>
                  <div className="site-name">{s.name}</div>
                  <div className="site-sub">
                    {s.protocol === "webdav"
                      ? s.baseUrl ?? "WebDAV"
                      : s.protocol === "dropbox"
                        ? s.dropboxAccount ?? "Dropbox"
                        : s.protocol === "onedrive"
                          ? s.onedriveAccount ?? "OneDrive"
                          : s.protocol === "gdrive"
                            ? s.gdriveAccount ?? "Google Drive"
                            : `${s.username}@${s.host}:${s.port}`}
                  </div>
                </div>
                <div className="site-actions">
                  <button
                    className="icon-btn"
                    title="Connect"
                    aria-label={`Connect to ${s.name}`}
                    disabled={connectingId === s.id}
                    onClick={() => void connect(s)}
                  >
                    <ConnectIcon />
                  </button>
                  <button className="icon-btn" title="Edit" aria-label={`Edit ${s.name}`} onClick={() => setEditing({ site: s })}>
                    <RenameIcon />
                  </button>
                  <button
                    className="icon-btn danger-text"
                    title="Delete site"
                    aria-label={`Delete ${s.name}`}
                    onClick={() => setSiteToDelete(s)}
                  >
                    <TrashIcon />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </aside>

      <main className="content">
        <div className="content-head">
          <strong>TransferJaguar</strong>
          <span style={{ flex: 1 }} />
          {session && (
            <>
              <span className="muted">
                {session.site.protocol === "webdav"
                  ? session.site.baseUrl ?? session.site.name
                  : session.site.protocol === "dropbox"
                    ? session.site.dropboxAccount ?? "Dropbox"
                    : session.site.protocol === "onedrive"
                      ? session.site.onedriveAccount ?? "OneDrive"
                      : session.site.protocol === "gdrive"
                        ? session.site.gdriveAccount ?? "Google Drive"
                        : `${session.site.username}@${session.site.host}`}
              </span>
              {connState === "reconnecting" && <span className="conn-reconnecting">reconnecting…</span>}
              <button className="secondary" onClick={() => void disconnect()}>Disconnect</button>
            </>
          )}
          <button className="icon-btn" title="Settings" aria-label="Settings" onClick={() => setShowSettings(true)}>
            <SettingsIcon />
          </button>
        </div>

        <div className="panes">
          <div className="pane-wrap">
            {localHome ? (
              <FilePane
                title="Local"
                side="local"
                ops={localOps}
                initialPath={localHome}
                onError={setToast}
                transferEnabled={!!session}
                transferLabel="Upload →"
                onTransfer={(fromSide, fromDir, entries) => void enqueueTransfer(fromSide, fromDir, entries)}
                onPathChange={onPanePath}
                reloadKey={localReload}
                showHidden={!!settings?.showHiddenFiles}
                directorySort={settings?.directorySort ?? "top"}
              />
            ) : (
              <div className="empty">Loading local files…</div>
            )}
          </div>
          <div className="pane-divider" />
          <div className="pane-wrap">
            {session && remoteOps ? (
              <FilePane
                key={session.sessionId}
                title={`Remote — ${session.site.name}`}
                side="remote"
                ops={remoteOps}
                initialPath={session.cwd}
                onError={setToast}
                transferEnabled={true}
                transferLabel="← Download"
                onTransfer={(fromSide, fromDir, entries) => void enqueueTransfer(fromSide, fromDir, entries)}
                onPathChange={onPanePath}
                reloadKey={remoteReload}
                showHidden={!!settings?.showHiddenFiles}
                directorySort={settings?.directorySort ?? "top"}
              />
            ) : (
              <div className="empty big">
                Connect to a site to browse remote files here.
              </div>
            )}
          </div>
        </div>

        <TransferQueue
          tasks={[...tasks.values()].sort((a, b) => b.createdAtMs - a.createdAtMs)}
          onCancel={(id) => {
            const t = tasks.get(id);
            // Confirm before canceling an active transfer; harmless states cancel directly.
            if (t && (t.status === "running" || t.status === "paused" || t.status === "queued")) {
              setCancelConfirm(t);
            } else {
              void window.transferJaguar.transferCancel(id);
            }
          }}
          onPause={(id) => void window.transferJaguar.transferPause(id)}
          onResume={(id) => void window.transferJaguar.transferResume(id)}
          onClearFinished={() => {
            void window.transferJaguar.transferClearFinished();
            setTasks((prev) => {
              const next = new Map<string, import("./shared/types").TransferTask>();
              for (const [id, t] of prev) {
                if (t.status !== "completed" && t.status !== "canceled" && t.status !== "error") next.set(id, t);
              }
              return next;
            });
          }}
        />
      </main>

      {editing && (
        <SiteEditorDialog
          site={editing.site}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refreshSites();
          }}
        />
      )}
      {hostKey && (
        <HostKeyDialog
          prompt={hostKey.prompt}
          onTrust={() => void trustAndConnect()}
          onCancel={() => setHostKey(null)}
        />
      )}
      {showSettings && settings && (
        <SettingsDialog
          settings={settings}
          onChange={(patch) => void updateSettings(patch)}
          onClose={() => setShowSettings(false)}
        />
      )}
      {siteToDelete && (
        <ConfirmDialog
          title={`Delete site “${siteToDelete.name}”?`}
          message={`This removes the saved connection for ${siteToDelete.username}@${siteToDelete.host} and its stored credentials. This cannot be undone. (Files on the server are not affected.)`}
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            const s = siteToDelete;
            setSiteToDelete(null);
            void removeSite(s);
          }}
          onCancel={() => setSiteToDelete(null)}
        />
      )}
      {cancelConfirm && (
        <ConfirmDialog
          title="Cancel this transfer?"
          message={`“${cancelConfirm.name}” is still transferring. Canceling stops it now and leaves any partially transferred file in place. Cancel it?`}
          confirmLabel="Cancel transfer"
          danger
          onConfirm={() => {
            void window.transferJaguar.transferCancel(cancelConfirm.id);
            setCancelConfirm(null);
          }}
          onCancel={() => setCancelConfirm(null)}
        />
      )}
      {pendingBatch && (
        <ConflictDialog
          names={pendingBatch.conflictNames}
          destDir={pendingBatch.destDir}
          onChoose={resolvePendingBatch}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
