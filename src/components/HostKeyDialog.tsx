import type { HostKeyPrompt } from "../shared/types";

interface Props {
  prompt: HostKeyPrompt;
  onTrust: () => void;
  onCancel: () => void;
}

/** Trust-on-first-use prompt for a new or changed host key. */
export function HostKeyDialog({ prompt, onTrust, onCancel }: Props) {
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" style={{ width: 480 }} onClick={(e) => e.stopPropagation()}>
        <h3>{prompt.changed ? "⚠️ Host key changed" : "Verify host key"}</h3>
        {prompt.changed ? (
          <p className="warn">
            The host key for <strong>{prompt.host}:{prompt.port}</strong> is DIFFERENT from the one you
            previously trusted. This could indicate a man-in-the-middle attack — or the server was
            legitimately reinstalled. Only continue if you expected this change.
          </p>
        ) : (
          <p>
            You're connecting to <strong>{prompt.host}:{prompt.port}</strong> for the first time. Verify
            this fingerprint through a trusted channel before continuing.
          </p>
        )}
        <div className="fingerprint">
          <div><span className="muted">Key type</span> {prompt.keyType}</div>
          <div><span className="muted">SHA-256</span> <code>{prompt.fingerprintSha256}</code></div>
        </div>
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>Cancel</button>
          <button className={prompt.changed ? "danger" : ""} onClick={onTrust}>
            Trust &amp; Connect
          </button>
        </div>
      </div>
    </div>
  );
}
