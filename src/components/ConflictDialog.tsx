/** The user's choice when a transfer destination already exists. */
export type ConflictChoice = "overwrite" | "rename" | "skip" | "cancel";

interface Props {
  /** Names that already exist at the destination (the conflicting items). */
  names: string[];
  /** Where the items are being transferred to (for context in the message). */
  destDir: string;
  /** Apply the chosen action; "cancel" aborts the whole batch. */
  onChoose: (choice: ConflictChoice) => void;
}

/** Prompt shown before a transfer when one or more destination items already
 *  exist. Offers Replace (overwrite), Keep both (auto-rename with " (1)", " (2)"),
 *  or Cancel (aborts the entire batch). A single choice applies to every
 *  conflicting item in the batch. */
export function ConflictDialog({ names, destDir, onChoose }: Props) {
  const count = names.length;
  const multiple = count > 1;
  const title = multiple ? `${count} items already exist` : `“${names[0]}” already exists`;
  const message = multiple
    ? `${count} items you're transferring already exist in ${destDir}. Choose what to do — your choice applies to all ${count}. “Skip” transfers the non-duplicate items and leaves these ${count} untouched.`
    : `An item named “${names[0]}” already exists in ${destDir}. Choose what to do.`;

  return (
    <div className="dialog-backdrop" onClick={() => onChoose("cancel")}>
      <div className="dialog" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{message}</p>
        {multiple && names.length <= 12 && (
          <ul className="conflict-list">
            {names.map((n) => (
              <li key={n} title={n}>{n}</li>
            ))}
          </ul>
        )}
        <div className="dialog-actions">
          <button className="secondary" onClick={() => onChoose("cancel")}>Cancel</button>
          <button className="secondary" onClick={() => onChoose("skip")}>Skip</button>
          <button onClick={() => onChoose("rename")}>Keep both</button>
          <button className="danger" onClick={() => onChoose("overwrite")}>Replace</button>
        </div>
      </div>
    </div>
  );
}
