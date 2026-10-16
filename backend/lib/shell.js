'use strict';
/**
 * lib/shell.js — helpers for the generated "organize loose files" bash script.
 */
const path = require('path');

/** POSIX single-quote a string so the shell treats it as one literal word. */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Map a container path back to the host path the user will run the script on.
 * /library/<LIBRARY_NAME>/x  →  <LIBRARY_HOST_PATH>/x   (when LIBRARY_HOST_PATH is set)
 * Without LIBRARY_NAME, LIBRARY_PATH itself maps to LIBRARY_HOST_PATH.
 * Falls back to the legacy /library/ → /volume1/ rewrite when unset.
 */
function toHostPath(p) {
  const host = process.env.LIBRARY_HOST_PATH;
  const libRoot = process.env.LIBRARY_PATH || '/library';
  if (host) {
    const name = process.env.LIBRARY_NAME;
    const prefix = path.posix.join(libRoot, name || '').replace(/\/+$/, '');
    if (p === prefix) return host.replace(/\/+$/, '') || '/';
    if (p.startsWith(prefix + '/')) return host.replace(/\/+$/, '') + p.slice(prefix.length);
    return p;
  }
  return p.replace(/^\/library\//, '/volume1/');
}

module.exports = { shellQuote, toHostPath };
