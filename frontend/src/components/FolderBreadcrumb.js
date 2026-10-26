import React from 'react';
import RoleMenu from './RoleMenu';

// Card detail → Folders: the card's folder path from the library root down,
// each segment with a role menu, so "this card is really the Heroes category"
// is one click from the card (docs/folder-roles.md §7).

export function hasFolderRoles(model) {
  return !!(model && Array.isArray(model.folderRoles) && model.folderRoles.length > 0);
}

export default function FolderBreadcrumb({ model, onSaved }) {
  if (!hasFolderRoles(model)) return null;
  const list = model.folderRoles;
  const titleId = `folders-title-${model.id}`;
  return (
    <section className="detail-card folder-crumbs" aria-labelledby={titleId}>
      <div className="detail-card-title" id={titleId}>Folders</div>
      <nav aria-label="Card folders">
        <ol className="folder-crumb-list">
          {list.map((f, i) => {
            const name = f.name || String(f.rel || f.path || '').split('/').filter(Boolean).pop() || f.path;
            return (
              <li key={f.path} className={`folder-crumb ${i === list.length - 1 ? 'current' : ''}`} style={{ paddingLeft: Math.min(i, 6) * 10 }}
                aria-current={i === list.length - 1 ? 'location' : undefined}>
                {i > 0 && <span className="folder-crumb-sep" aria-hidden="true">›</span>}
                <span className="folder-crumb-name" title={f.path}>{name}</span>
                <RoleMenu path={f.path} name={name} mark={{ role: f.role || null, source: f.source || null, conflict: f.conflict }}
                  onSaved={onSaved} />
              </li>
            );
          })}
        </ol>
      </nav>
      <div className="attr-faint folder-crumb-hint">Mark a folder to change how the scanner groups this card. It applies on the next scan.</div>
    </section>
  );
}
