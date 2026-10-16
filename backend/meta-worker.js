'use strict';
/**
 * meta-worker.js — loads <library>/_Meta off the main thread (manifests, Drive listing and the
 * tracker can be large) and posts back lib/meta-summary.js's plain summary.
 */
const { parentPort, workerData } = require('worker_threads');
const { loadLibraryMeta, summarize, failed } = require('./lib/meta-summary');

try {
  parentPort.postMessage(summarize(loadLibraryMeta(workerData.root).meta));
} catch (e) {
  parentPort.postMessage(failed(`_Meta could not be loaded: ${e.message}`));
}
