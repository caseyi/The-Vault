import React, { useState } from 'react';
import { EDITION_ORDER, variantLabel, compareVariants } from '../library';

export function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const TYPE_STYLE = {
  stl:    { bg: 'rgba(76,175,125,0.15)',  color: 'var(--green-text)', label: 'STL' },
  slicer: { bg: 'rgba(91,155,213,0.15)',  color: 'var(--blue-text)', label: 'SLC' },
  zip:    { bg: 'rgba(212,170,76,0.15)',  color: 'var(--yellow-text)', label: 'ZIP' },
  plate:  { bg: 'rgba(155,114,207,0.15)', color: 'var(--purple-text)', label: 'PLT' },
  image:  { bg: 'rgba(193,127,58,0.15)',  color: 'var(--accent-text)', label: 'IMG' },
  other:  { bg: 'rgba(100,100,120,0.15)', color: 'var(--text-faint)', label: 'OTH' },
};

// Role detection from filename — renders, supports, FDM, resin, etc.
const ROLE_PATTERNS = [
  { re: /render|preview|thumb|photo/i,   label: 'Renders',  color: '#c17f3a' },
  { re: /support/i,                       label: 'Supported',color: '#9b72cf' },
  { re: /\bfdm\b|fused/i,                label: 'FDM',      color: '#5b9bd5' },
  { re: /resin|msla|sla/i,               label: 'Resin',    color: '#4caf7d' },
  { re: /presupported|pre.?sup/i,        label: 'Pre-supp', color: '#4caf7d' },
  { re: /base|scenic|terrain/i,          label: 'Terrain',  color: '#8b7355' },
  { re: /bust/i,                          label: 'Bust',     color: '#b08060' },
];

function detectRole(name) {
  for (const { re, label, color } of ROLE_PATTERNS) {
    if (re.test(name)) return { label, color };
  }
  return null;
}

function FileBadge({ type }) {
  const s = TYPE_STYLE[type] || TYPE_STYLE.other;
  return (
    <span style={{
      background: s.bg, color: s.color,
      fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 1,
      padding: '2px 5px', borderRadius: 3, flexShrink: 0,
    }}>{s.label}</span>
  );
}

function RoleBadge({ name }) {
  const role = detectRole(name);
  if (!role) return null;
  return (
    <span style={{
      background: 'transparent', color: role.color,
      border: `1px solid ${role.color}40`,
      fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 1,
      padding: '1px 5px', borderRadius: 3, flexShrink: 0,
    }}>{role.label}</span>
  );
}

const PRINTABLE_TYPES = new Set(['stl', 'slicer', 'zip']);

function FileRow({ file, onView3D, viewing3D, printMode, onTogglePrinted, showLibrary, hideRole }) {
  const isPrinted = !!file.printed_at;
  const isPrintable = PRINTABLE_TYPES.has(file.filetype);

  return (
    <div
      className={printMode && isPrintable ? `print-file-row${isPrinted ? ' is-printed' : ''}` : ''}
      style={{
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '5px 8px',
        borderRadius: 4,
        background: viewing3D ? 'rgba(193,127,58,0.06)' : 'transparent',
        transition: 'background 0.1s',
        opacity: printMode && isPrintable && isPrinted ? 0.5 : 1,
      }}
      onMouseEnter={e => { if (!viewing3D && !(printMode && isPrintable)) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
      onMouseLeave={e => { if (!viewing3D && !(printMode && isPrintable)) e.currentTarget.style.background = 'transparent'; }}
    >
      {printMode && isPrintable ? (
        <button
          onClick={() => onTogglePrinted && onTogglePrinted(file)}
          className={`print-checkbox${isPrinted ? ' checked' : ''}`}
          title={isPrinted ? `Printed ${new Date(file.printed_at).toLocaleDateString()}` : 'Mark as printed'}
        >
          {isPrinted ? '✓' : ''}
        </button>
      ) : null}
      <FileBadge type={file.filetype} />
      <span className="file-name" style={{
        flex: 1, fontSize: 11, color: 'var(--text)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        fontFamily: 'var(--font-mono)',
        textDecoration: printMode && isPrintable && isPrinted ? 'line-through' : 'none',
      }} title={file.filename}>
        {file.filename}
      </span>
      {!hideRole && <RoleBadge name={file.filename} />}
      {showLibrary && file.library && (
        <span className="file-library" title={`On ${file.library}`}>{file.library}</span>
      )}
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)', flexShrink: 0 }}>
        {formatBytes(file.filesize)}
      </span>
      {!printMode && file.filetype === 'stl' && onView3D && (
        <button onClick={() => onView3D(file)}
          style={{
            background: viewing3D ? 'rgba(193,127,58,0.2)' : 'var(--bg4)',
            border: `1px solid ${viewing3D ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 3, color: viewing3D ? 'var(--accent)' : 'var(--text-faint)',
            padding: '2px 6px', cursor: 'pointer', fontSize: 9,
            fontFamily: 'var(--font-mono)', flexShrink: 0,
          }}>
          {viewing3D ? '✕' : '3D'}
        </button>
      )}
    </div>
  );
}

function ReleaseSection({ releaseName, files, defaultOpen = true, onView3D, viewingStlId, printMode, onTogglePrinted }) {
  const [open, setOpen] = useState(defaultOpen);
  const role = detectRole(releaseName || '');
  const stlCount  = files.filter(f => f.filetype === 'stl').length;
  const zipCount  = files.filter(f => f.filetype === 'zip').length;
  const slcCount  = files.filter(f => f.filetype === 'slicer').length;

  const summary = [
    stlCount  && `${stlCount} STL`,
    slcCount  && `${slcCount} slicer`,
    zipCount  && `${zipCount} ZIP`,
  ].filter(Boolean).join(' · ');

  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 6,
      overflow: 'hidden',
      marginBottom: 6,
    }}>
      {/* Section header */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          width: '100%', padding: '7px 10px',
          background: open ? 'rgba(193,127,58,0.06)' : 'var(--bg3)',
          border: 'none', cursor: 'pointer', textAlign: 'left',
          borderBottom: open ? '1px solid var(--border)' : 'none',
          transition: 'background 0.12s',
        }}
      >
        <span style={{ fontSize: 10, color: 'var(--text-faint)', flexShrink: 0 }}>
          {open ? '▾' : '▸'}
        </span>

        {releaseName ? (
          <span style={{
            fontSize: 12, color: 'var(--text)',
            fontFamily: 'var(--font-mono)',
            flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {releaseName}
          </span>
        ) : (
          <span style={{ fontSize: 11, color: 'var(--text-faint)', fontStyle: 'italic', flex: 1 }}>
            Ungrouped files
          </span>
        )}

        {role && (
          <span style={{
            background: 'transparent', color: role.color,
            border: `1px solid ${role.color}50`,
            fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 1,
            padding: '1px 5px', borderRadius: 3, flexShrink: 0,
          }}>{role.label}</span>
        )}

        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)',
          flexShrink: 0,
        }}>
          {summary || `${files.length} file${files.length !== 1 ? 's' : ''}`}
        </span>
      </button>

      {/* File rows */}
      {open && (
        <div style={{ padding: '4px 4px' }}>
          {files.map(f => (
            <FileRow
              key={f.id}
              file={f}
              onView3D={onView3D}
              viewing3D={viewingStlId === f.id}
              printMode={printMode}
              onTogglePrinted={onTogglePrinted}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const editionRank = (e) => { const i = EDITION_ORDER.indexOf(e); return e == null ? 99 : i < 0 ? EDITION_ORDER.length : i; };

/** Group files by edition, then variant (works from the library-metadata scanner). */
export function groupByEditionVariant(files) {
  const eds = new Map();
  for (const f of files) {
    const ed = f.edition || null;
    if (!eds.has(ed)) eds.set(ed, new Map());
    const vars = eds.get(ed);
    const v = f.variant || null;
    if (!vars.has(v)) vars.set(v, []);
    vars.get(v).push(f);
  }
  return [...eds.entries()]
    .sort((a, b) => editionRank(a[0]) - editionRank(b[0]) || String(a[0]).localeCompare(String(b[0])))
    .map(([edition, vars]) => ({
      edition,
      files: [...vars.values()].flat(),
      variants: [...vars.entries()]
        .sort((a, b) => compareVariants(a[0], b[0]))
        .map(([variant, list]) => ({ variant, label: variantLabel(variant), files: [...list].sort((x, y) => String(x.filename).localeCompare(String(y.filename))) })),
    }));
}

function VariantGroups({ variants, rowProps, viewingStlId }) {
  return variants.map(v => (
    <div key={v.variant || '__none__'} className="variant-group" role="group" aria-label={v.label}>
      <div className="variant-label">
        <span>{v.label}</span>
        <span className="variant-count">{v.files.length}</span>
      </div>
      {v.files.map(f => (
        <FileRow key={f.id} file={f} viewing3D={viewingStlId === f.id} hideRole {...rowProps} />
      ))}
    </div>
  ));
}

function EditionSection({ edition, files, variants, defaultOpen, rowProps, viewingStlId, otherLabel }) {
  const [open, setOpen] = useState(defaultOpen);
  const total = files.reduce((a, f) => a + (Number(f.filesize) || 0), 0);
  const libs = [...new Set(files.map(f => f.library).filter(Boolean))].sort();
  return (
    <section className="edition-section" aria-label={edition || otherLabel}>
      <button type="button" className={`edition-head ${open ? 'open' : ''}`} onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span aria-hidden="true" className="edition-chevron">{open ? '▾' : '▸'}</span>
        <span className="edition-name">{edition || otherLabel}</span>
        {rowProps.showLibrary && libs.length > 0 && <span className="edition-libs">{libs.join(' + ')}</span>}
        <span className="edition-summary">{files.length} file{files.length !== 1 ? 's' : ''}{total ? ` · ${formatBytes(total)}` : ''}</span>
      </button>
      {open && (
        <div className="edition-body">
          <VariantGroups variants={variants} rowProps={rowProps} viewingStlId={viewingStlId} />
        </div>
      )}
    </section>
  );
}

export default function ReleaseFileList({ files = [], onView3D, viewingStlId, printMode, onTogglePrinted, showLibrary }) {
  // Works from the layout-aware scanner carry edition/variant per file
  if (files.some(f => f.edition || f.variant)) {
    const groups = groupByEditionVariant(files);
    const rowProps = { onView3D, printMode, onTogglePrinted, showLibrary };
    if (groups.length === 1 && !groups[0].edition) {
      return <div className="work-files"><VariantGroups variants={groups[0].variants} rowProps={rowProps} viewingStlId={viewingStlId} /></div>;
    }
    return (
      <div className="work-files">
        {groups.map(g => (
          <EditionSection key={g.edition || '__none__'} edition={g.edition} otherLabel="Other files"
            files={g.files} variants={g.variants} defaultOpen={groups.length <= 3 || g === groups[0]}
            rowProps={rowProps} viewingStlId={viewingStlId} />
        ))}
      </div>
    );
  }

  // Group by release_name (null = ungrouped, goes last)
  const groups = new Map();
  for (const f of files) {
    const key = f.release_name || null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }

  // Sort: named releases alphabetically, null last
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a.localeCompare(b);
  });

  if (sortedKeys.length === 0) {
    return (
      <div style={{ fontSize: 12, color: 'var(--text-faint)', fontStyle: 'italic', padding: '8px 0' }}>
        No files indexed yet.
      </div>
    );
  }

  // If only one group (all ungrouped), skip the section header and just list flat
  if (sortedKeys.length === 1 && sortedKeys[0] === null) {
    return (
      <div>
        {groups.get(null).map(f => (
          <FileRow key={f.id} file={f} onView3D={onView3D} viewing3D={viewingStlId === f.id}
            printMode={printMode} onTogglePrinted={onTogglePrinted} showLibrary={showLibrary} />
        ))}
      </div>
    );
  }

  return (
    <div>
      {sortedKeys.map((key, i) => (
        <ReleaseSection
          key={key ?? '__ungrouped__'}
          releaseName={key}
          files={groups.get(key)}
          defaultOpen={i === 0 || groups.size <= 3}
          onView3D={onView3D}
          viewingStlId={viewingStlId}
          printMode={printMode}
          onTogglePrinted={onTogglePrinted}
        />
      ))}
    </div>
  );
}
