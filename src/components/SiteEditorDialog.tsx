import { useState } from "react";
import type { Site, SiteInput, AuthMethod } from "../shared/types";

interface Props {
  /** Existing site to edit, or null to create a new one. */
  site: Site | null;
  onCancel: () => void;
  onSaved: () => void;
}

/** Create/edit a connection profile. The secret (password or key passphrase) is
 *  write-only here — it's sent to the keychain on save and never read back. */
export function SiteEditorDialog({ site, onCancel, onSaved }: Props) {
  const [name, setName] = useState(site?.name ?? "");
  const [host, setHost] = useState(site?.host ?? "");
  const [port, setPort] = useState(String(site?.port ?? 22));
  const [username, setUsername] = useState(site?.username ?? "");
  const [authMethod, setAuthMethod] = useState<AuthMethod>(site?.authMethod ?? "password");
  const [privateKeyPath, setPrivateKeyPath] = useState(site?.privateKeyPath ?? "");
  const [startDir, setStartDir] = useState(site?.startDir ?? "");
  const [compression, setCompression] = useState(!!site?.compression);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);

  const secretLabel =
    authMethod === "password" ? "Password" : authMethod === "key" ? "Key passphrase (optional)" : "";

  async function save() {
    setError(null);
    if (!name.trim()) return setError("Enter a name.");
    if (!host.trim()) return setError("Enter a host.");
    if (!username.trim()) return setError("Enter a username.");
    const portNum = Number(port) || 22;
    if (authMethod === "key" && !privateKeyPath.trim()) {
      return setError("Choose a private key file for key authentication.");
    }
    const input: SiteInput = {
      id: site?.id,
      name: name.trim(),
      host: host.trim(),
      port: portNum,
      username: username.trim(),
      authMethod,
      privateKeyPath: authMethod === "key" ? privateKeyPath.trim() : undefined,
      startDir: startDir.trim() || undefined,
      compression,
      secret: secret.length > 0 ? secret : undefined,
    };
    try {
      await window.jaguar.saveSite(input);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the site.");
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
        <h3>{site ? "Edit Site" : "New Site"}</h3>

        <div className="field">
          <label>Name</label>
          <input value={name} placeholder="e.g. Work server" onChange={(e) => setName(e.target.value)} />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <div className="field" style={{ flex: 3 }}>
            <label>Host</label>
            <input value={host} placeholder="host.example.com" onChange={(e) => setHost(e.target.value)} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Port</label>
            <input value={port} onChange={(e) => setPort(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="field">
          <label>Authentication</label>
          <select value={authMethod} onChange={(e) => setAuthMethod(e.target.value as AuthMethod)}>
            <option value="password">Password</option>
            <option value="key">Private key</option>
            <option value="agent">SSH agent</option>
          </select>
        </div>
        {authMethod === "key" && (
          <div className="field">
            <label>Private key path</label>
            <input
              value={privateKeyPath}
              placeholder="~/.ssh/id_ed25519"
              onChange={(e) => setPrivateKeyPath(e.target.value)}
            />
          </div>
        )}
        {authMethod !== "agent" && (
          <div className="field">
            <label>{secretLabel}</label>
            <input
              type="password"
              value={secret}
              placeholder={site ? "•••••• (leave blank to keep current)" : ""}
              onChange={(e) => setSecret(e.target.value)}
            />
          </div>
        )}
        <div className="field">
          <label>Start directory (optional)</label>
          <input value={startDir} placeholder="/home/user" onChange={(e) => setStartDir(e.target.value)} />
        </div>
        <label className="check-row">
          <input type="checkbox" checked={compression} onChange={(e) => setCompression(e.target.checked)} />
          Enable compression (helps on slow links)
        </label>

        {error && <div className="error">{error}</div>}
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>Cancel</button>
          <button onClick={() => void save()}>Save</button>
        </div>
      </div>
    </div>
  );
}
