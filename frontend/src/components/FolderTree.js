import React, { useState } from 'react';

/**
 * Recursive folder-tree node.
 * `node` = { name, path, count, children: [] }
 * `activePath` = the currently-selected folder path (absolute, e.g. /library/STL Archive/Creator)
 * `onSelect(path)` filters the gallery to that folder (and everything beneath it).
 */
function TreeNode({ node, depth, activePath, onSelect }) {
  // Auto-open ancestors of the active node so the selection is always visible.
  const containsActive = activePath && activePath.startsWith(node.path + '/');
  const [open, setOpen] = useState(depth < 1 || containsActive);
  const hasChildren = node.children && node.children.length > 0;
  const isActive = activePath === node.path;

  return (
    <div>
      <div
        className={`folder-row ${isActive ? 'active' : ''}`}
        style={{ paddingLeft: 6 + depth * 12 }}
      >
        <button
          className="folder-twisty"
          onClick={() => hasChildren && setOpen(o => !o)}
          style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
          title={open ? 'Collapse' : 'Expand'}
        >
          {open ? '▾' : '▸'}
        </button>
        <button className="folder-label" onClick={() => onSelect(isActive ? '' : node.path)}>
          <span className="folder-icon">{hasChildren ? '🗂' : '📁'}</span>
          <span className="folder-name">{node.name}</span>
          <span className="count">{node.count}</span>
        </button>
      </div>
      {open && hasChildren && (
        <div>
          {node.children.map(child => (
            <TreeNode key={child.path} node={child} depth={depth + 1}
              activePath={activePath} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function FolderTree({ tree, activePath, onSelect }) {
  if (!tree || !tree.children || tree.children.length === 0) {
    return (
      <div style={{ fontSize: 11, color: 'var(--text-faint)', padding: '4px 0' }}>
        No folders yet. Scan your library first.
      </div>
    );
  }
  return (
    <div className="folder-tree" style={{ maxHeight: 320, overflowY: 'auto' }}>
      {tree.children.map(child => (
        <TreeNode key={child.path} node={child} depth={0}
          activePath={activePath} onSelect={onSelect} />
      ))}
    </div>
  );
}
