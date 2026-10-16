import React from 'react';
import {
  asList, sortEditions, formatTerm, sourceLabel, explainConfidence, CONFIDENCE_LABELS,
  FIELD_SOURCE_LABELS, isAttributed,
} from '../library';

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

export function hasAttributionData(model) {
  if (!model) return false;
  return !!(model.studio || model.character || model.release_term || model.attribution || model.confidence
    || asList(model.products).length || asList(model.editions).length);
}

export default function AttributionPanel({ model }) {
  if (!hasAttributionData(model)) return null;
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
  const explanation = confidence ? explainConfidence(attribution, { source: model.source }) : '';

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
      {model.franchise && (
        <Row label="Genre" field="franchise" fields={fields}>
          {model.franchise}
          {group && <><span className="attr-sep" aria-hidden="true"> › </span><span className="sr-only">, group </span>{group}</>}
        </Row>
      )}
      {!model.franchise && group && <Row label="Group">{group}</Row>}
      {model.character && <Row label="Character" field="character" fields={fields}>{model.character}</Row>}
      {editions.length > 0 && (
        <Row label="Editions" field="editions" fields={fields}>
          <span className="attr-chips">{editions.map(e => <span key={e} className={`edition-chip ed-${e.toLowerCase()}`}>{e}</span>)}</span>
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
