import React, { useState } from 'react';
import { aiTooltip, isAiProv, pct, band, BAND_LABELS, FIELD_LABELS, asValues, addedValues } from '../enrich';
import {
  asList, sortEditions, formatTerm, sourceLabel, explainConfidence, CONFIDENCE_LABELS,
  FIELD_SOURCE_LABELS, isAttributed,
} from '../library';
import { roleLabel, suggestionFolder } from '../folderRoles';

// "Where did this come from?" panel on the model detail page: studio, creator,
// genre/group/character, editions, release term, source links, claim status and
// how confident the match to a purchase is. Renders nothing for models that
// carry none of these fields (older backend, plain folder models).

const ext = { target: '_blank', rel: 'noopener noreferrer' };

function isGumroad(url) {
  try { return /(^|\.)gumroad\.com$/i.test(new URL(url).hostname); } catch { return false; }
}

function formatDate(d) {
  if (!d) return '';
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(d);
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function ProductLinks({ product }) {
  const links = [];
  if (product.productUrl) {
    links.push(
      <a key="p" href={product.productUrl} {...ext} className="attr-link">
        {isGumroad(product.productUrl) ? 'View on Gumroad' : 'Product page'}<span aria-hidden="true"> ↗</span>
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  if (product.libraryUrl) {
    links.push(
      <a key="l" href={product.libraryUrl} {...ext} className="attr-link">
        {isGumroad(product.libraryUrl) ? 'Your Gumroad library' : 'Your download'}<span aria-hidden="true"> ↗</span>
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  if (!links.length) return null;
  return <span className="attr-links">{links}</span>;
}

function Row({ label, field, fields, children }) {
  const from = fields && field && fields[field];
  return (
    <div className="meta-row attr-row">
      <span className="meta-label" title={from ? `From ${FIELD_SOURCE_LABELS[from] || from}` : undefined}>{label}</span>
      <span className="attr-val">{children}</span>
    </div>
  );
}

function ProductRow({ product, showLinks }) {
  const missing = asList(product.missing);
  const total = Number(product.totalFiles) || 0;
  const matched = Number(product.matchedFiles) || 0;
  const pct = total ? Math.round((matched / total) * 100) : null;
  return (
    <li className="attr-product">
      <div className="attr-product-name" title={product.name}>{product.name}</div>
      <div className="attr-product-meta">
        {product.edition && <span className="edition-chip">{product.edition}</span>}
        {product.term && <span title={product.termLabel || undefined}>{formatTerm(product.term)}</span>}
        {total > 0 && (
          <span className={`attr-match ${matched === total ? 'full' : ''}`}>
            {matched}/{total} files on NAS
            <span className="attr-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
          </span>
        )}
        {product.status && <span className="attr-status">{product.status}</span>}
      </div>
      {showLinks && <ProductLinks product={product} />}
      {missing.length > 0 && (
        <details className="attr-missing">
          <summary>{missing.length} file{missing.length !== 1 ? 's' : ''} not on the NAS</summary>
          <ul>
            {missing.map(m => <li key={m} title={m}>{m}</li>)}
          </ul>
        </details>
      )}
    </li>
  );
}

/** Small "AI" marker for a field filled by enrichment (tooltip: confidence + run). */
export function AiMark({ attribution, enrichment, field }) {
  const prov = attribution && attribution.fields && attribution.fields[field];
  if (!isAiProv(prov)) return null;
  const conf = attribution.ai && attribution.ai[field];
  const tip = aiTooltip(prov, conf, enrichment);
  return (
    <span className={`ai-mark ${prov === 'ai-reviewed' ? 'reviewed' : ''}`} title={tip}>
      <span aria-hidden="true">{prov === 'ai-reviewed' ? 'AI ✓' : 'AI'}</span>
      <span className="sr-only"> ({tip})</span>
    </span>
  );
}

function EditForm({ fields, onSave, onCancel }) {
  const [vals, setVals] = useState(() => Object.fromEntries(fields.map(f => [f.key, f.value || ''])));
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    const changed = Object.fromEntries(fields.filter(f => (vals[f.key] || '') !== (f.value || '')).map(f => [f.key, vals[f.key].trim()]));
    const ok = Object.keys(changed).length ? await onSave(changed) : true;
    setBusy(false);
    if (ok !== false) onCancel();
  };
  return (
    <form className="attr-edit" onSubmit={submit} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}>
      {fields.map((f, i) => (
        <label key={f.key} className="attr-edit-field">
          <span>{f.label}</span>
          <input className="url-input" value={vals[f.key]} autoFocus={i === 0} placeholder={f.placeholder}
            onChange={e => setVals(v => ({ ...v, [f.key]: e.target.value }))} disabled={busy} />
        </label>
      ))}
      <div className="attr-edit-actions">
        <button type="button" className="org-btn org-btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="org-btn org-btn-sm org-btn-success" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
      <div className="attr-faint" style={{ fontSize: 10 }}>Values you set are never overwritten by scans or AI.</div>
    </form>
  );
}

function EditButton({ label, onClick }) {
  return <button type="button" className="attr-edit-btn" onClick={onClick} aria-label={`Edit ${label}`} title={`Edit ${label}`}>✎</button>;
}

function suggestionText(s) {
  if (s.type === 'merge') return null;
  if (s.type === 'role') {
    return <>Mark <b title={s.path}>{suggestionFolder(s)}</b> as <ins className="diff-new">{roleLabel(s.proposed)}</ins></>;
  }
  const cur = asValues(s.current);
  if (s.field === 'tags' || s.field === 'editions' || Array.isArray(s.proposed)) {
    return <>{addedValues(s.current, s.proposed).map(v => <ins key={v} className="diff-new">+ {v}</ins>)}</>;
  }
  return (
    <>
      {cur.length ? <del className="diff-old">{cur.join(', ')}</del> : <span className="diff-empty">empty</span>}
      <span className="diff-arrow" aria-hidden="true"> → </span><span className="sr-only"> becomes </span>
      <ins className="diff-new">{String(s.proposed ?? '')}</ins>
    </>
  );
}

function InlineSuggestions({ items, onDecide }) {
  const [busy, setBusy] = useState(null);
  if (!items.length) return null;
  const decide = async (s, decision) => {
    setBusy(s.id);
    try { await onDecide([s.id], decision, s); } finally { setBusy(null); }
  };
  return (
    <div className="attr-suggestions">
      <div className="attr-subtitle">AI suggestions ({items.length})</div>
      <ul>
        {items.map(s => {
          const b = band(s.confidence);
          const label = s.type === 'merge' ? 'Same character as' : s.type === 'rename' ? 'Name' : s.type === 'role' ? 'Folder role' : (FIELD_LABELS[s.field] || s.field);
          return (
            <li key={s.id} className="attr-sugg">
              <div className="attr-sugg-line">
                <span className="review-field">{label}</span>
                {s.type === 'merge' ? <b className="attr-sugg-target">{s.target?.name || `#${s.target?.id}`}</b> : <span className="diff">{suggestionText(s)}</span>}
              </div>
              <div className="attr-sugg-meta">
                {b && <span className={`conf-chip conf-${b}`}>{BAND_LABELS[b]} {pct(s.confidence)}</span>}
                {s.source === 'vision' && <span className="source-chip">👁 vision</span>}
                <span className="review-reason">{s.reason}</span>
              </div>
              <div className="attr-sugg-actions">
                <button className="org-btn org-btn-sm org-btn-success" disabled={busy != null} onClick={() => decide(s, 'accept')}
                  aria-label={`Accept: ${label} ${s.type === 'merge' ? s.target?.name : s.proposed}`}>✓ {s.type === 'merge' ? 'Merge' : 'Accept'}</button>
                <button className="org-btn org-btn-sm" disabled={busy != null} onClick={() => decide(s, 'reject')}
                  aria-label={`Reject: ${label} ${s.type === 'merge' ? s.target?.name : s.proposed}`}>✕ Reject</button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function hasAttributionData(model) {
  if (!model) return false;
  return !!(model.studio || model.character || model.release_term || model.attribution || model.confidence
    || asList(model.products).length || asList(model.editions).length);
}

export default function AttributionPanel({ model, onSaveField, onDecide }) {
  const [editing, setEditing] = useState(null); // 'character' | 'genre'
  if (!hasAttributionData(model)) return null;
  const editable = !!onSaveField;
  const suggestions = Array.isArray(model.suggestions) ? model.suggestions.filter(s => !s.status || s.status === 'pending') : [];
  const products = Array.isArray(model.products) ? model.products : [];
  const attribution = model.attribution || (model.confidence ? { confidence: model.confidence } : null);
  const fields = attribution && attribution.fields;
  const confidence = attribution && attribution.confidence;
  const editions = sortEditions(asList(model.editions));
  const libraries = [...new Set(asList(model.libraries))].sort();
  const termLabels = [...new Set(products.map(p => p.termLabel).filter(Boolean))];
  if (!termLabels.length && model.release_label && model.kind !== 'release-item') termLabels.push(model.release_label);
  const termTitle = termLabels.length ? `Drive term: ${termLabels.join(' / ')}` : undefined;
  const claimed = products.map(p => p.claimed).filter(Boolean).sort()[0];
  const statuses = [...new Set(products.map(p => p.status).filter(Boolean))];
  const single = products.length === 1 ? products[0] : null;
  const creator = model.creator_name && model.creator_name !== model.studio ? model.creator_name : '';
  const norm = s => String(s || '').trim().toLowerCase();
  const group = model.group_name && ![norm(model.character), norm(model.name), norm(model.franchise)].includes(norm(model.group_name)) ? model.group_name : '';
  const knownSource = model.source && model.source !== 'unknown';
  const folded = (Array.isArray(attribution && attribution.foldedFrom) ? attribution.foldedFrom : [])
    .map(e => (typeof e === 'string' ? e : e && e.name)).filter(Boolean);
  const explanation = confidence ? explainConfidence(attribution, { source: model.source }) : '';
  const mark = (f) => <AiMark attribution={attribution} enrichment={model.enrichment} field={f} />;

  return (
    <section className="detail-card attr-panel" aria-labelledby={`attr-title-${model.id}`}>
      <div className="detail-card-title attr-title">
        <span id={`attr-title-${model.id}`}>Attribution</span>
        {confidence && (
          <span className={`conf-badge conf-${confidence} ${isAttributed(confidence) ? '' : 'weak'}`}>
            {CONFIDENCE_LABELS[confidence] || confidence}
          </span>
        )}
      </div>

      {(model.studio || creator) && (
        <Row label={model.studio ? 'Studio' : 'Creator'} field="studio" fields={fields}>
          {model.studio || creator}
          {model.studio && creator && <><span className="attr-sep" aria-hidden="true"> › </span><span className="sr-only">, creator </span>{creator}</>}
        </Row>
      )}
      {editing === 'genre' ? (
        <EditForm onSave={onSaveField} onCancel={() => setEditing(null)} fields={[
          { key: 'franchise', label: 'Genre', value: model.franchise, placeholder: 'Marvel, DC, Movies…' },
          { key: 'group_name', label: 'Group', value: model.group_name, placeholder: 'X-Men, Jurassic Park…' },
        ]} />
      ) : (model.franchise || (editable && !group)) ? (
        <Row label="Genre" field="franchise" fields={fields}>
          {model.franchise || <span className="attr-faint">—</span>}{mark('franchise')}
          {group && <><span className="attr-sep" aria-hidden="true"> › </span><span className="sr-only">, group </span>{group}{mark('group_name')}</>}
          {editable && <EditButton label="genre and group" onClick={() => setEditing('genre')} />}
        </Row>
      ) : group ? (
        <Row label="Group">{group}{mark('group_name')}{editable && <EditButton label="genre and group" onClick={() => setEditing('genre')} />}</Row>
      ) : null}
      {editing === 'character' ? (
        <EditForm onSave={onSaveField} onCancel={() => setEditing(null)} fields={[
          { key: 'character', label: 'Character', value: model.character, placeholder: 'Canonical name, e.g. Jean Grey' },
        ]} />
      ) : (model.character || editable) ? (
        <Row label="Character" field="character" fields={fields}>
          {model.character || <span className="attr-faint">—</span>}{mark('character')}
          {editable && <EditButton label="character" onClick={() => setEditing('character')} />}
        </Row>
      ) : null}
      {editions.length > 0 && (
        <Row label="Editions" field="editions" fields={fields}>
          <span className="attr-chips">{editions.map(e => <span key={e} className={`edition-chip ed-${e.toLowerCase()}`}>{e}</span>)}{mark('editions')}</span>
        </Row>
      )}
      {model.release_label && model.kind === 'release-item' && <Row label="Release">{model.release_label}</Row>}
      {model.release_term && (
        <Row label="Term" field="release_term" fields={fields}>
          <span title={termTitle} className={termTitle ? 'attr-term has-tip' : 'attr-term'}>{formatTerm(model.release_term)}</span>
          {termTitle && <span className="sr-only"> ({termTitle})</span>}
        </Row>
      )}
      {(knownSource || single) && (
        <Row label="Source" field="source" fields={fields}>
          {knownSource && <span>{sourceLabel(model.source)}</span>}
          {single && <ProductLinks product={single} />}
        </Row>
      )}
      {(claimed || statuses.length > 0) && (
        <Row label="Status">
          {statuses.length > 0 ? statuses.join(' / ') : 'Claimed'}
          {claimed && <span className="attr-status"> · since {formatDate(claimed)}</span>}
        </Row>
      )}
      {libraries.length > 0 && <Row label={libraries.length > 1 ? 'Libraries' : 'Library'}>{libraries.join(' + ')}</Row>}

      {onDecide && <InlineSuggestions items={suggestions} onDecide={onDecide} />}

      {folded.length > 0 && (
        <p className="attr-folded">Includes data from: {[...new Set(folded)].join(', ')}</p>
      )}
      {explanation && <p className={`attr-explain ${isAttributed(confidence) ? '' : 'weak'}`}>{explanation}</p>}

      {products.length > 0 && (
        <div className="attr-products">
          <div className="attr-subtitle">{products.length === 1 ? 'Product' : `Products (${products.length})`}</div>
          <ul>
            {products.map((p, i) => <ProductRow key={`${p.name}-${i}`} product={p} showLinks={!single} />)}
          </ul>
        </div>
      )}
    </section>
  );
}
