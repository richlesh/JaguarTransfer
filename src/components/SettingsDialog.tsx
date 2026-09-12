import type { AppSettings } from "../shared/ipc";

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  onClose: () => void;
}

/** Settings panel. M2/M3 scope: a single Appearance option (light/dark). */
export function SettingsDialog({ settings, onChange, onClose }: Props) {
  const theme = settings.theme ?? "light";
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
        <h3>Settings</h3>

        <div className="field">
          <label>Appearance</label>
          <select value={theme} onChange={(e) => onChange({ theme: e.target.value as "light" | "dark" })}>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>

        <label className="check-row">
          <input
            type="checkbox"
            checked={!!settings.showHiddenFiles}
            onChange={(e) => onChange({ showHiddenFiles: e.target.checked })}
          />
          Show hidden files (names starting with “.”)
        </label>

        <div className="field">
          <label>Directories in file list</label>
          <select
            value={settings.directorySort ?? "top"}
            onChange={(e) => onChange({ directorySort: e.target.value as "top" | "inline" | "bottom" })}
          >
            <option value="top">At the top</option>
            <option value="inline">Inline (sorted with files)</option>
            <option value="bottom">At the bottom</option>
          </select>
        </div>

        <div className="dialog-actions">
          <button onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
