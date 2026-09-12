import { useCallback, useEffect, useState } from "react";
import type { FsListing } from "../shared/types";
import { FolderEntryIcon } from "./Icons";

interface TreeOps {
  list(path: string): Promise<FsListing>;
  sep: string;
}

interface Props {
  ops: TreeOps;
  /** Root directory path for the tree. */
  root: string;
  /** The file list's current path (highlighted in the tree). */
  currentPath: string;
  /** Called when the user clicks a folder — sets it as the current directory. */
  onSelect: (path: string) => void;
  onError: (msg: string) => void;
  /** Show dotfile directories (names starting with "."). When false, hidden. */
  showHidden: boolean;
}

function joinPath(base: string, name: string, sep: string): string {
  return base.replace(new RegExp(`${sep === "\\" ? "\\\\" : sep}+$`), "") + sep + name;
}

function baseName(path: string, sep: string): string {
  const trimmed = path.replace(new RegExp(`${sep === "\\" ? "\\\\" : sep}+$`), "");
  const idx = trimmed.lastIndexOf(sep);
  return idx >= 0 ? trimmed.slice(idx + 1) || trimmed : trimmed;
}

/** One expandable directory node. Loads its subdirectories lazily on first
 *  expand. A right-pointing triangle (▶) means collapsed; downward (▼) expanded.
 *  Nodes with no subdirectories show no triangle. */
function TreeNode({
  ops,
  path,
  label,
  depth,
  currentPath,
  onSelect,
  onError,
  showHidden,
}: {
  ops: TreeOps;
  path: string;
  label: string;
  depth: number;
  currentPath: string;
  onSelect: (p: string) => void;
  onError: (m: string) => void;
  showHidden: boolean;
}) {
  const [expanded, setExpanded] = useState(depth === 0);
  const [children, setChildren] = useState<string[] | null>(null); // null = not loaded
  const [loading, setLoading] = useState(false);

  const loadChildren = useCallback(async () => {
    setLoading(true);
    try {
      const listing = await ops.list(path);
      setChildren(
        listing.entries
          .filter((e) => e.kind === "directory" && (showHidden || !e.name.startsWith(".")))
          .map((e) => e.name)
      );
    } catch (e) {
      setChildren([]);
      onError(e instanceof Error ? e.message : "Could not read the directory.");
    } finally {
      setLoading(false);
    }
  }, [ops, path, onError, showHidden]);

  // Auto-load the root's children so the tree isn't empty on open.
  useEffect(() => {
    if (depth === 0 && children === null) void loadChildren();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depth]);

  const toggle = async () => {
    if (!expanded && children === null) await loadChildren();
    setExpanded((v) => !v);
  };

  // Unknown-children nodes are assumed potentially-expandable (show a triangle)
  // until proven empty after a load.
  const hasTriangle = children === null || children.length > 0;
  const isCurrent = path === currentPath;

  return (
    <div className="tree-node">
      <div
        className={"tree-row" + (isCurrent ? " current" : "")}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => onSelect(path)}
      >
        <span
          className="tree-caret"
          onClick={(e) => { e.stopPropagation(); void toggle(); }}
        >
          {hasTriangle ? (expanded ? "▼" : "▶") : ""}
        </span>
        <span className="tree-folder-icon"><FolderEntryIcon size={14} /></span>
        <span className="tree-label" title={path}>{label}</span>
      </div>
      {expanded && children && children.length > 0 && (
        <div className="tree-children">
          {children.map((name) => (
            <TreeNode
              key={name}
              ops={ops}
              path={joinPath(path, name, ops.sep)}
              label={name}
              depth={depth + 1}
              currentPath={currentPath}
              onSelect={onSelect}
              onError={onError}
              showHidden={showHidden}
            />
          ))}
        </div>
      )}
      {expanded && loading && <div className="tree-loading" style={{ paddingLeft: 6 + (depth + 1) * 14 }}>…</div>}
    </div>
  );
}

/** A directories-only hierarchical tree rooted at `root`. */
export function DirTree({ ops, root, currentPath, onSelect, onError, showHidden }: Props) {
  return (
    <div className="dir-tree">
      <TreeNode
        ops={ops}
        path={root}
        label={baseName(root, ops.sep) || root}
        depth={0}
        currentPath={currentPath}
        onSelect={onSelect}
        onError={onError}
        showHidden={showHidden}
      />
    </div>
  );
}
