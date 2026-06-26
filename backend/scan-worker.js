'use strict';
/**
 * scan-worker.js — runs a library scan in a worker thread so the heavy,
 * synchronous filesystem work (especially over slow SMB mounts) never blocks
 * the main server's event loop. Progress and the final result are posted back
 * to the main thread via parentPort; the main thread owns scan state + SSE.
 *
 * better-sqlite3 opens its own connection here (the DB is in WAL mode, which
 * allows the worker to write while the main thread reads).
 */
const { parentPort, workerData } = require('worker_threads');
const { scanLibrary, scanSingleCreator } = require('./scanner');

const post = (msg) => parentPort.postMessage(msg);
const logger = (level, msg) => post({ type: 'log', level, msg });

const fullProgress = (p) => {
  if (p.stage !== 'scanning') return;
  if (p.model) post({ type: 'log', level: 'scan', msg: `  ${p.creator} / ${p.model}` });
  else if (p.creator) post({ type: 'log', level: 'creator', msg: `▸ Creator: ${p.creator}` });
};

const creatorProgress = (p) => {
  if (p.stage === 'scanning' && p.model) post({ type: 'log', level: 'scan', msg: `  ${p.creator} / ${p.model}` });
};

(async () => {
  try {
    let result;
    if (workerData.mode === 'creator') {
      const { folderPath, creatorId, creatorName } = workerData;
      result = await scanSingleCreator(folderPath, creatorId, creatorName, creatorProgress, logger);
    } else {
      const { libPath, force } = workerData;
      if (force) {
        // Clear folder hashes so nothing is skipped (done here, off the main thread)
        const db = require('./db');
        db.prepare('UPDATE models SET folder_hash = NULL').run();
      }
      result = await scanLibrary(libPath, fullProgress, logger);
    }
    post({ type: 'done', success: true, result });
  } catch (err) {
    post({ type: 'done', success: false, error: err.message });
  }
})();
