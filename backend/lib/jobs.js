'use strict';
/**
 * lib/jobs.js — allow only one AI batch job at a time (they spend API credits
 * and hammer rate limits; two at once is almost always an accidental double-click
 * or a reconnecting EventSource).
 */
let current = null;

/** Try to start a job. Returns a release() function, or null if one is running. */
function acquireAiJob(name) {
  if (current) return null;
  const token = { name, startedAt: new Date().toISOString() };
  current = token;
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    if (current === token) current = null;
  };
}

function currentAiJob() {
  return current ? { ...current } : null;
}

/** Express helper: acquire or answer 409. Returns release() or null (response already sent). */
function acquireOr409(res, name) {
  const release = acquireAiJob(name);
  if (!release) {
    res.status(409).json({ error: `Another AI job is already running (${current.name}, started ${current.startedAt}). Wait for it to finish or close it first.`, running: currentAiJob() });
    return null;
  }
  return release;
}

module.exports = { acquireAiJob, currentAiJob, acquireOr409 };
