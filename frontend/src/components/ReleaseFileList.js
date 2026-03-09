import React, { useState } from 'react';

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const TYPE_STYLE = {
  stl:    { bg: 'rgba(76,175,125,0.15)',  color: '#4caf7d', label: 'STL' },
  slicer: { bg: 'rgba(91,155,213,0.15)',  color: '#5b9bd5', label: 'SLC' },
  zip:    { bg: 'rgba(212,170,76,0.15)',  color: '#d4aa4c', label: 'ZIP' },
  plate:  { bg: 'rgba(155,114,207,0.15)', color: '#9b72cf', label: 'PLT' },
  image:  { bg: 'rgba(193,127,58,0.15)',  color: '#c17f3a', label: 'IMG' },
  other:  { bg: 'rgba(100,100,120,0.15)', color: '#667',    label: 'OTH' },
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

function FileRow({ file, onView3D, viewing3D }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 7,
      padding: '5px 8px',
      borderRadius: 4,
      background: viewing3D ? 'rgba(193,127,58,0.06)' : 'transparent',
      transition: 'background 0.1s',
    }}
      onMouseEnter={e => { if (!viewing3D) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
      onMouseLeave={e => { if (!viewing3D) e.currentTarget.style.background = 'transparent'; }}
    >
      <FileBadge type={file.filetype} />
      <span style={{
        flex: 1, fontSize: 11, color: 'var(--text)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        fontFamily: 'var(--font-mono)',
      }} title={file.filename}>
        {file.filename}
      </span>
      <RoleBadge name={file.filename} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)', flexShrink: 0 }}>
        {formatBytes(file.filesize)}
      </span>
      {file.filetype === 'stl' && onView3D && (
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

function ReleaseSection({ releaseName, files, defaultOpen = true, onView3D, viewingStlId }) {
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
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ReleaseFileList({ files = [], onView3D, viewingStlId }) {
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
          <FileRow key={f.id} file={f} onView3D={onView3D} viewing3D={viewingStlId === f.id} />
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
        />
      ))}
    </div>
  );
}
