'use strict';
/**
 * lib/meta-summary.js — the part of _Meta the API needs (/api/meta/status, /api/attribution/*),
 * as plain data that can cross a worker boundary. The scan worker sends one after every scan and
 * meta-worker.js builds one on demand, so the server never parses _Meta on its main thread.
 */
const path = require('path');
const metaLib = require('./meta');
const librariesLib = require('./libraries');

/** Libraries (top-level folders) + the merged _Meta of every library. */
function loadLibraryMeta(root, log = () => {}) {
  let libs = librariesLib.listLibraries(root);
  const dirs = [...new Set([path.join(root, '_Meta'), ...libs.map(l => path.join(l.path, '_Meta'))])];
  const meta = metaLib.loadMeta({ dirs, roots: [...new Set([root, ...libs.map(l => l.path)])], log });
  if (meta.vault && meta.vault.libraryLabels) libs = librariesLib.listLibraries(root, meta.vault.libraryLabels);
  return { meta, libs };
}

function summarize(meta) {
  return {
    loadedAt: meta.loadedAt || new Date().toISOString(),
    status: metaLib.metaStatus(meta),
    libraryLabels: (meta.vault && meta.vault.libraryLabels) || null,
    // organizer rules (fix/genre/group/guess…) and genre_map: AI prompt context and export de-duplication
    rules: meta.rules || {},
    genreMap: Object.fromEntries(meta.genreMap instanceof Map ? meta.genreMap : []),
    products: (meta.products || []).filter(p => !p.unknown).map(p => ({
      creator: p.creator, rawCreator: p.rawCreator || '', studio: p.studio || null, name: p.name, term: p.term || null,
      libraryUrl: p.libraryUrl || null, productUrl: p.productUrl || null,
      files: p.files.length, bytes: p.files.reduce((t, f) => t + (f.size || f.approxSize || 0), 0),
      keys: p.files.filter(f => f.size).map(f => `${f.key}|${f.size}`),
    })),
  };
}

function failed(message) {
  const s = summarize(metaLib.emptyMeta());
  s.status.errors.push(message);
  return s;
}

module.exports = { loadLibraryMeta, summarize, failed };
