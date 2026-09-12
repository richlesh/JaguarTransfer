import { useCallback, useEffect, useMemo, useState } from "react";
import type { Site, HostKeyPrompt } from "./shared/types";
import { SiteEditorDialog } from "./components/SiteEditorDialog";
import { HostKeyDialog } from "./components/HostKeyDialog";
import { FilePane, type PaneOps } from "./components/FilePane";

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

  const refreshSites = useCallback(async () => {
    setSites(await window.jaguar.listSites());
  }, []);

  useEffect(() => {
    void refreshSites();
    void window.jaguar.localHome().then(setLocalHome);
  }, [refreshSites]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const connect = useCallback(async (site: Site) => {
    setConnectingId(site.id);
    try {
      const res = await window.jaguar.connect(site.id);
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
    await window.jaguar.hostkeyTrust(prompt);
    setHostKey(null);
    await connect(site);
  }, [hostKey, connect]);

  const disconnect = useCallback(async () => {
    if (!session) return;
    await window.jaguar.disconnect(session.sessionId);
    setSession(null);
  }, [session]);

  const removeSite = useCallback(
    async (site: Site) => {
      if (session?.site.id === site.id) await disconnect();
      await window.jaguar.deleteSite(site.id);
      await refreshSites();
    },
    [session, disconnect, refreshSites]
  );

  // Local pane ops: native path separator (matches the OS the app runs on).
  const localSep = navigator.platform.startsWith("Win") ? "\\" : "/";
  const localOps = useMemo<PaneOps>(
    () => ({
      list: (p) => window.jaguar.localList(p),
      rename: (from, toName) => window.jaguar.localRename(from, toName),
      mkdir: (parent, name) => window.jaguar.localMkdir(parent, name),
      delete: (p) => window.jaguar.localDelete(p),
      sep: localSep,
    }),
    [localSep]
  );

  // Remote pane ops: bound to the active session; POSIX paths.
  const remoteOps = useMemo<PaneOps | null>(() => {
    if (!session) return null;
    const sid = session.sessionId;
    return {
      list: (p) => window.jaguar.remoteList(sid, p),
      rename: (from, toName) => window.jaguar.remoteRename(sid, from, toName),
      mkdir: (parent, name) => window.jaguar.remoteMkdir(sid, parent, name),
      delete: (p) => window.jaguar.remoteDelete(sid, p),
      sep: "/",
    };
  }, [session]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <strong>Sites</strong>
          <button className="secondary" onClick={() => setEditing({ site: null })}>+ New</button>
        </div>
        <div className="site-list">
          {sites.length === 0 ? (
            <div className="empty">No sites yet. Add one to connect.</div>
          ) : (
            sites.map((s) => (
              <div key={s.id} className={"site-item" + (session?.site.id === s.id ? " active" : "")}>
                <div className="site-main" onDoubleClick={() => void connect(s)}>
                  <div className="site-name">{s.name}</div>
                  <div className="site-sub">{s.username}@{s.host}:{s.port}</div>
                </div>
                <div className="site-actions">
                  <button className="secondary" disabled={connectingId === s.id} onClick={() => void connect(s)}>
                    {connectingId === s.id ? "…" : "Connect"}
                  </button>
                  <button className="secondary" onClick={() => setEditing({ site: s })}>Edit</button>
                  <button className="secondary" onClick={() => void removeSite(s)}>✕</button>
                </div>
              </div>
            ))
          )}
        </div>
      </aside>

      <main className="content">
        <div className="content-head">
          <strong>JaguarTransfer</strong>
          <span style={{ flex: 1 }} />
          {session && (
            <>
              <span className="muted">{session.site.username}@{session.site.host}</span>
              <button className="secondary" onClick={() => void disconnect()}>Disconnect</button>
            </>
          )}
        </div>

        <div className="panes">
          <div className="pane-wrap">
            {localHome ? (
              <FilePane title="Local" ops={localOps} initialPath={localHome} onError={setToast} />
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
                ops={remoteOps}
                initialPath={session.cwd}
                onError={setToast}
              />
            ) : (
              <div className="empty big">
                Connect to a site to browse remote files here.
              </div>
            )}
          </div>
        </div>
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
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
