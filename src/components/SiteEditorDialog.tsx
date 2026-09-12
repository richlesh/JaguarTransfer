import { useState } from "react";
import type { Site, SiteInput, AuthMethod, Protocol, WebdavAuth, FtpSecurity } from "../shared/types";

interface Props {
  /** Existing site to edit, or null to create a new one. */
  site: Site | null;
  onCancel: () => void;
  onSaved: () => void;
}

/** Create/edit a connection profile. The secret (password or key passphrase) is
 *  write-only here — it's sent to the keychain on save and never read back. */
export function SiteEditorDialog({ site, onCancel, onSaved }: Props) {
  const [protocol, setProtocol] = useState<Protocol>(site?.protocol ?? "sftp");
  const [name, setName] = useState(site?.name ?? "");
  const [host, setHost] = useState(site?.host ?? "");
  const [port, setPort] = useState(String(site?.port ?? 22));
  const [username, setUsername] = useState(site?.username ?? "");
  const [authMethod, setAuthMethod] = useState<AuthMethod>(site?.authMethod ?? "password");
  const [privateKeyPath, setPrivateKeyPath] = useState(site?.privateKeyPath ?? "");
  const [startDir, setStartDir] = useState(site?.startDir ?? "");
  const [compression, setCompression] = useState(!!site?.compression);
  const [useRsync, setUseRsync] = useState(!!site?.useRsync);
  const defaultRsync = navigator.platform.startsWith("Win") ? "" : "/usr/bin/rsync";
  const [rsyncPath, setRsyncPath] = useState(site?.rsyncPath ?? defaultRsync);
  const [secret, setSecret] = useState("");
  // WebDAV.
  const [baseUrl, setBaseUrl] = useState(site?.baseUrl ?? "");
  const [webdavAuth, setWebdavAuth] = useState<WebdavAuth>(site?.webdavAuth ?? "basic");
  // FTP / FTPS.
  const [ftpSecurity, setFtpSecurity] = useState<FtpSecurity>(site?.ftpSecurity ?? "explicit");
  // Dropbox.
  const [dropboxStartPath, setDropboxStartPath] = useState(site?.dropboxStartPath ?? "");
  const [dropboxAccount, setDropboxAccount] = useState(site?.dropboxAccount ?? "");
  const [dropboxConnecting, setDropboxConnecting] = useState(false);
  // OneDrive.
  const [onedriveStartPath, setOnedriveStartPath] = useState(site?.onedriveStartPath ?? "");
  const [onedriveAccount, setOnedriveAccount] = useState(site?.onedriveAccount ?? "");
  const [onedriveConnecting, setOnedriveConnecting] = useState(false);
  // Google Drive.
  const [gdriveStartPath, setGdriveStartPath] = useState(site?.gdriveStartPath ?? "");
  const [gdriveAccount, setGdriveAccount] = useState(site?.gdriveAccount ?? "");
  const [gdriveConnecting, setGdriveConnecting] = useState(false);
  // Jump host / bastion.
  const [jumpEnabled, setJumpEnabled] = useState(!!site?.jump?.enabled);
  const [jumpHost, setJumpHost] = useState(site?.jump?.host ?? "");
  const [jumpPort, setJumpPort] = useState(String(site?.jump?.port ?? 22));
  const [jumpUser, setJumpUser] = useState(site?.jump?.username ?? "");
  const [jumpAuth, setJumpAuth] = useState<AuthMethod>(site?.jump?.authMethod ?? "password");
  const [jumpKeyPath, setJumpKeyPath] = useState(site?.jump?.privateKeyPath ?? "");
  const [jumpSecret, setJumpSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const secretLabel =
    protocol === "webdav"
      ? webdavAuth === "bearer"
        ? "Bearer token"
        : webdavAuth === "basic"
          ? "Password"
          : ""
      : protocol === "ftp"
        ? "Password"
        : authMethod === "password"
          ? "Password"
          : authMethod === "key"
            ? "Key passphrase (optional)"
            : "";

  /** Validate the current form for the active protocol. Returns an error message
   *  or null when valid. */
  function validate(): string | null {
    if (!name.trim()) return "Enter a name.";
    if (protocol === "webdav") {
      const url = baseUrl.trim();
      if (!url) return "Enter the WebDAV URL.";
      if (!/^https?:\/\//i.test(url)) return "The WebDAV URL must start with http:// or https://.";
      if (webdavAuth === "basic" && !username.trim()) return "Enter a username for Basic authentication.";
      return null;
    }
    if (protocol === "ftp") {
      if (!host.trim()) return "Enter a host.";
      if (!username.trim()) return "Enter a username (use \"anonymous\" for anonymous FTP).";
      return null;
    }
    if (protocol === "dropbox") {
      // No host/credentials; connection is via OAuth. Name is enough to save.
      return null;
    }
    if (protocol === "onedrive") {
      return null;
    }
    if (protocol === "gdrive") {
      return null;
    }
    // SFTP
    if (!host.trim()) return "Enter a host.";
    if (!username.trim()) return "Enter a username.";
    if (authMethod === "key" && !privateKeyPath.trim()) {
      return "Choose a private key file for key authentication.";
    }
    if (jumpEnabled) {
      if (!jumpHost.trim()) return "Enter the jump host, or disable it.";
      if (!jumpUser.trim()) return "Enter the jump host username.";
      if (jumpAuth === "key" && !jumpKeyPath.trim()) return "Choose a private key file for the jump host.";
    }
    return null;
  }

  /** Build the SiteInput from the current form values for the active protocol. */
  function buildInput(): SiteInput {
    if (protocol === "webdav") {
      const url = baseUrl.trim();
      return {
        id: site?.id,
        protocol: "webdav",
        name: name.trim(),
        // host/port/authMethod are unused for WebDAV but kept in the model; fill
        // with harmless defaults so the shared Site shape stays valid.
        host: url,
        port: 0,
        username: webdavAuth === "basic" ? username.trim() : "",
        authMethod: "password",
        baseUrl: url,
        webdavAuth,
        startDir: startDir.trim() || undefined,
        secret: secret.length > 0 ? secret : undefined,
      };
    }
    if (protocol === "ftp") {
      const defaultPort = ftpSecurity === "implicit" ? 990 : 21;
      return {
        id: site?.id,
        protocol: "ftp",
        name: name.trim(),
        host: host.trim(),
        port: Number(port) || defaultPort,
        username: username.trim(),
        authMethod: "password",
        ftpSecurity,
        startDir: startDir.trim() || undefined,
        secret: secret.length > 0 ? secret : undefined,
      };
    }
    if (protocol === "dropbox") {
      return {
        id: site?.id,
        protocol: "dropbox",
        name: name.trim(),
        // host/port/username unused for Dropbox; harmless placeholders.
        host: "",
        port: 0,
        username: "",
        authMethod: "password",
        dropboxStartPath: dropboxStartPath.trim() || undefined,
        dropboxAccount: dropboxAccount.trim() || undefined,
      };
    }
    if (protocol === "onedrive") {
      return {
        id: site?.id,
        protocol: "onedrive",
        name: name.trim(),
        host: "",
        port: 0,
        username: "",
        authMethod: "password",
        onedriveStartPath: onedriveStartPath.trim() || undefined,
        onedriveAccount: onedriveAccount.trim() || undefined,
      };
    }
    if (protocol === "gdrive") {
      return {
        id: site?.id,
        protocol: "gdrive",
        name: name.trim(),
        host: "",
        port: 0,
        username: "",
        authMethod: "password",
        gdriveStartPath: gdriveStartPath.trim() || undefined,
        gdriveAccount: gdriveAccount.trim() || undefined,
      };
    }
    return {
      id: site?.id,
      protocol: "sftp",
      name: name.trim(),
      host: host.trim(),
      port: Number(port) || 22,
      username: username.trim(),
      authMethod,
      privateKeyPath: authMethod === "key" ? privateKeyPath.trim() : undefined,
      startDir: startDir.trim() || undefined,
      compression,
      useRsync,
      rsyncPath: useRsync ? rsyncPath.trim() || undefined : undefined,
      secret: secret.length > 0 ? secret : undefined,
      jump: jumpEnabled
        ? {
            enabled: true,
            host: jumpHost.trim(),
            port: Number(jumpPort) || 22,
            username: jumpUser.trim(),
            authMethod: jumpAuth,
            privateKeyPath: jumpAuth === "key" ? jumpKeyPath.trim() : undefined,
          }
        : undefined,
      jumpSecret: jumpEnabled && jumpSecret.length > 0 ? jumpSecret : undefined,
    };
  }

  async function save() {
    setError(null);
    setTestResult(null);
    const err = validate();
    if (err) return setError(err);
    try {
      await window.transferJaguar.saveSite(buildInput());
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the site.");
    }
  }

  /** Connect to Dropbox via OAuth. Saves the draft first (to obtain a site id),
   *  runs the consent flow, and reflects the connected account. */
  /** Connect an OAuth account (Dropbox / OneDrive / Google Drive) via the consent
   *  flow. Saves the draft first (to obtain a site id), then runs OAuth and
   *  reflects the connected account. */
  async function connectOAuth() {
    setError(null);
    const err = validate();
    if (err) return setError(err);
    const cfg =
      protocol === "onedrive"
        ? { setConnecting: setOnedriveConnecting, setAccount: setOnedriveAccount, label: "OneDrive account", name: "OneDrive" }
        : protocol === "gdrive"
          ? { setConnecting: setGdriveConnecting, setAccount: setGdriveAccount, label: "Google Drive account", name: "Google Drive" }
          : { setConnecting: setDropboxConnecting, setAccount: setDropboxAccount, label: "Dropbox account", name: "Dropbox" };
    cfg.setConnecting(true);
    try {
      const saved = await window.transferJaguar.saveSite(buildInput());
      const res = await window.transferJaguar.oauthConnect(saved.id);
      if (res.ok) {
        cfg.setAccount(res.account ?? cfg.label);
      } else {
        setError(res.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : `Could not connect to ${cfg.name}.`);
    } finally {
      cfg.setConnecting(false);
    }
  }

  /** Attempt a connection with the current (unsaved) values; persists nothing. */
  async function testConnection() {
    setError(null);
    setTestResult(null);
    const err = validate();
    if (err) return setError(err);
    setTesting(true);
    try {
      const res = await window.transferJaguar.testConnection(buildInput());
      if (res.ok) {
        setTestResult({ ok: true, message: res.detail ?? "Connected." });
      } else {
        setTestResult({ ok: false, message: res.error });
      }
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : "Test failed." });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
        <h3>{site ? "Edit Site" : "New Site"}</h3>

        <div className="field">
          <label>Protocol</label>
          <select value={protocol} onChange={(e) => setProtocol(e.target.value as Protocol)}>
            <option value="dropbox">Dropbox</option>
            <option value="ftp">FTP / FTPS</option>
            <option value="gdrive">Google Drive</option>
            <option value="onedrive">OneDrive</option>
            <option value="sftp">SFTP (SSH)</option>
            <option value="webdav">WebDAV (HTTP/HTTPS)</option>
          </select>
        </div>

        <div className="field">
          <label>Name</label>
          <input value={name} placeholder="e.g. Work server" onChange={(e) => setName(e.target.value)} />
        </div>

        {protocol === "gdrive" ? (
          <>
            <div className="field">
              <label>Google Drive account</label>
              <div className="dropbox-connect">
                <span className={gdriveAccount ? "dropbox-status connected" : "dropbox-status"}>
                  {gdriveAccount ? `Connected: ${gdriveAccount}` : "Not connected"}
                </span>
                <button
                  type="button"
                  className="secondary"
                  disabled={gdriveConnecting}
                  onClick={() => void connectOAuth()}
                >
                  {gdriveConnecting ? "Connecting…" : gdriveAccount ? "Reconnect" : "Connect to Google Drive"}
                </button>
              </div>
              <p className="field-hint">
                Connecting opens Google in a browser window to authorize TransferJaguar. Saving
                the site first is required, so “Connect” saves it for you. Google-format files
                (Docs, Sheets, Slides) download as Office files (.docx/.xlsx/.pptx; others as PDF).
              </p>
            </div>
            <div className="field">
              <label>Start folder (optional)</label>
              <input
                value={gdriveStartPath}
                placeholder="/ (My Drive root)"
                onChange={(e) => setGdriveStartPath(e.target.value)}
              />
            </div>
          </>
        ) : protocol === "onedrive" ? (
          <>
            <div className="field">
              <label>OneDrive account</label>
              <div className="dropbox-connect">
                <span className={onedriveAccount ? "dropbox-status connected" : "dropbox-status"}>
                  {onedriveAccount ? `Connected: ${onedriveAccount}` : "Not connected"}
                </span>
                <button
                  type="button"
                  className="secondary"
                  disabled={onedriveConnecting}
                  onClick={() => void connectOAuth()}
                >
                  {onedriveConnecting ? "Connecting…" : onedriveAccount ? "Reconnect" : "Connect to OneDrive"}
                </button>
              </div>
              <p className="field-hint">
                Connecting opens Microsoft in a browser window to authorize TransferJaguar. Saving
                the site first is required, so “Connect” saves it for you.
              </p>
            </div>
            <div className="field">
              <label>Start folder (optional)</label>
              <input
                value={onedriveStartPath}
                placeholder="/ (drive root)"
                onChange={(e) => setOnedriveStartPath(e.target.value)}
              />
            </div>
          </>
        ) : protocol === "dropbox" ? (
          <>
            <div className="field">
              <label>Dropbox account</label>
              <div className="dropbox-connect">
                <span className={dropboxAccount ? "dropbox-status connected" : "dropbox-status"}>
                  {dropboxAccount ? `Connected: ${dropboxAccount}` : "Not connected"}
                </span>
                <button
                  type="button"
                  className="secondary"
                  disabled={dropboxConnecting}
                  onClick={() => void connectOAuth()}
                >
                  {dropboxConnecting ? "Connecting…" : dropboxAccount ? "Reconnect" : "Connect to Dropbox"}
                </button>
              </div>
              <p className="field-hint">
                Connecting opens Dropbox in a browser window to authorize TransferJaguar. Saving
                the site first is required, so “Connect” saves it for you.
              </p>
            </div>
            <div className="field">
              <label>Start folder (optional)</label>
              <input
                value={dropboxStartPath}
                placeholder="/ (account root)"
                onChange={(e) => setDropboxStartPath(e.target.value)}
              />
            </div>
          </>
        ) : protocol === "ftp" ? (
          <>
            <div style={{ display: "flex", gap: 8 }}>
              <div className="field" style={{ flex: 3 }}>
                <label>Host</label>
                <input value={host} placeholder="ftp.example.com" onChange={(e) => setHost(e.target.value)} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Port</label>
                <input
                  value={port}
                  placeholder={ftpSecurity === "implicit" ? "990" : "21"}
                  onChange={(e) => setPort(e.target.value)}
                />
              </div>
            </div>
            <div className="field">
              <label>Security</label>
              <select value={ftpSecurity} onChange={(e) => setFtpSecurity(e.target.value as FtpSecurity)}>
                <option value="explicit">Explicit FTPS (AUTH TLS, port 21)</option>
                <option value="implicit">Implicit FTPS (TLS, port 990)</option>
                <option value="none">Plain FTP (no encryption)</option>
              </select>
            </div>
            {ftpSecurity === "none" && (
              <div className="warn-box">
                ⚠ Plain FTP sends your username, password, and files <strong>unencrypted</strong>.
                Anyone on the network can read them. Use Explicit or Implicit FTPS whenever the
                server supports it.
              </div>
            )}
            <div className="field">
              <label>Username</label>
              <input value={username} placeholder="anonymous" onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className="field">
              <label>{secretLabel}</label>
              <input
                type="password"
                value={secret}
                placeholder={site ? "•••••• (leave blank to keep current)" : ""}
                onChange={(e) => setSecret(e.target.value)}
              />
            </div>
            <div className="field">
              <label>Start directory (optional)</label>
              <input value={startDir} placeholder="/" onChange={(e) => setStartDir(e.target.value)} />
            </div>
          </>
        ) : protocol === "webdav" ? (
          <>
            <div className="field">
              <label>WebDAV URL</label>
              <input
                value={baseUrl}
                placeholder="https://cloud.example.com/remote.php/dav/files/alice/"
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </div>
            <div className="field">
              <label>Authentication</label>
              <select value={webdavAuth} onChange={(e) => setWebdavAuth(e.target.value as WebdavAuth)}>
                <option value="basic">Username &amp; password (Basic)</option>
                <option value="bearer">Bearer token</option>
                <option value="none">None (public)</option>
              </select>
            </div>
            {webdavAuth === "basic" && (
              <div className="field">
                <label>Username</label>
                <input value={username} onChange={(e) => setUsername(e.target.value)} />
              </div>
            )}
            {webdavAuth !== "none" && (
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
              <input value={startDir} placeholder="/" onChange={(e) => setStartDir(e.target.value)} />
            </div>
          </>
        ) : (
          <>
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

            <label className="check-row">
              <input type="checkbox" checked={useRsync} onChange={(e) => setUseRsync(e.target.checked)} />
              Use rsync for file copies (when available)
            </label>
            {useRsync && (
              <div className="rsync-section">
                <div className="field">
                  <label>rsync executable path</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      style={{ flex: 1 }}
                      value={rsyncPath}
                      placeholder={defaultRsync || "e.g. C:\\Program Files\\cwRsync\\bin\\rsync.exe"}
                      onChange={(e) => setRsyncPath(e.target.value)}
                    />
                    <button
                      type="button"
                      className="secondary"
                      onClick={async () => {
                        const picked = await window.transferJaguar.pickFile({
                          title: "Locate the rsync executable",
                          defaultPath: rsyncPath || undefined,
                        });
                        if (picked) setRsyncPath(picked);
                      }}
                    >
                      Browse…
                    </button>
                  </div>
                </div>
                {authMethod === "password" && (
                  <div className="warn-box">
                    ⚠ rsync needs <strong>key</strong> or <strong>SSH agent</strong> authentication —
                    it can't use a password. With password auth, transfers fall back to the built-in
                    method. rsync also isn't used when a jump host is configured.
                  </div>
                )}
              </div>
            )}

            <label className="check-row">
              <input type="checkbox" checked={jumpEnabled} onChange={(e) => setJumpEnabled(e.target.checked)} />
              Connect through a jump host (bastion)
            </label>
            {jumpEnabled && (
              <div className="jump-section">
                <div style={{ display: "flex", gap: 8 }}>
                  <div className="field" style={{ flex: 3 }}>
                    <label>Jump host</label>
                    <input value={jumpHost} placeholder="bastion.example.com" onChange={(e) => setJumpHost(e.target.value)} />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label>Port</label>
                    <input value={jumpPort} onChange={(e) => setJumpPort(e.target.value)} />
                  </div>
                </div>
                <div className="field">
                  <label>Jump username</label>
                  <input value={jumpUser} onChange={(e) => setJumpUser(e.target.value)} />
                </div>
                <div className="field">
                  <label>Jump authentication</label>
                  <select value={jumpAuth} onChange={(e) => setJumpAuth(e.target.value as AuthMethod)}>
                    <option value="password">Password</option>
                    <option value="key">Private key</option>
                    <option value="agent">SSH agent</option>
                  </select>
                </div>
                {jumpAuth === "key" && (
                  <div className="field">
                    <label>Jump private key path</label>
                    <input value={jumpKeyPath} placeholder="~/.ssh/id_ed25519" onChange={(e) => setJumpKeyPath(e.target.value)} />
                  </div>
                )}
                {jumpAuth !== "agent" && (
                  <div className="field">
                    <label>{jumpAuth === "password" ? "Jump password" : "Jump key passphrase (optional)"}</label>
                    <input
                      type="password"
                      value={jumpSecret}
                      placeholder={site?.jump ? "•••••• (leave blank to keep current)" : ""}
                      onChange={(e) => setJumpSecret(e.target.value)}
                    />
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {error && <div className="error">{error}</div>}
        {testResult && (
          <div className={testResult.ok ? "test-result ok" : "test-result fail"}>
            {testResult.ok ? "✓ " : "✕ "}
            {testResult.message}
          </div>
        )}
        <div className="dialog-actions split">
          <button className="secondary" onClick={() => void testConnection()} disabled={testing}>
            {testing ? "Testing…" : "Test Connection"}
          </button>
          <span className="dialog-actions-right">
            <button className="secondary" onClick={onCancel}>Cancel</button>
            <button onClick={() => void save()}>Save</button>
          </span>
        </div>
      </div>
    </div>
  );
}
