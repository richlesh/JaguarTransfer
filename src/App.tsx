import { useCallback, useEffect, useState } from "react";
import type { Site, HostKeyPrompt } from "./shared/types";
import { SiteEditorDialog } from "./components/SiteEditorDialog";
import { HostKeyDialog } from "./components/HostKeyDialog";
import { RemotePane } from "./components/RemotePane";

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
  const [toast, setToast] = useState<string | null>(null);

  const refreshSites = useCallback(async () => {
    setSites(await window.jaguar.listSites());
  }, []);

  useEffect(() => {
    void refreshSites();
  }, [refreshSites]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const connect = useCallback(
    async (site: Site) => {
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
    },
    []
  );

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
              <div
                key={s.id}
                className={"site-item" + (session?.site.id === s.id ? " active" : "")}
              >
                <div className="site-main" onDoubleClick={() => void connect(s)}>
                  <div className="site-name">{s.name}</div>
                  <div className="site-sub">{s.username}@{s.host}:{s.port}</div>
                </div>
                <div className="site-actions">
                  <button
                    className="secondary"
                    disabled={connectingId === s.id}
                    onClick={() => void connect(s)}
                  >
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
        {session ? (
          <RemotePane
            key={session.sessionId}
            sessionId={session.sessionId}
            initialPath={session.cwd}
            onError={setToast}
          />
        ) : (
          <div className="empty big">
            Select a site and click <strong>Connect</strong> to browse remote files.
          </div>
        )}
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
