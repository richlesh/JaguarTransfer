import { useState } from "react";

interface Props {
  title: string;
  label: string;
  initialValue?: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

/** A single-text-field modal (used for rename and new-folder). */
export function PromptDialog({ title, label, initialValue = "", confirmLabel = "OK", onConfirm, onCancel }: Props) {
  const [value, setValue] = useState(initialValue);
  const submit = () => {
    const v = value.trim();
    if (v) onConfirm(v);
  };
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="field">
          <label>{label}</label>
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); submit(); }
              else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
            }}
          />
        </div>
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>Cancel</button>
          <button onClick={submit}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
