'use strict';
/**
 * lib/claude.js — the one place that talks to api.anthropic.com.
 *
 * callClaudeAPI(apiKey, body, { timeoutMs, signal })  → parsed JSON response
 * claudeStream(apiKey, body, onChunk, { timeoutMs, signal }) → resolves at end of stream
 *
 * Both check the HTTP status before parsing (so an HTML error page never turns
 * into "Unexpected token '<'"), map common statuses to readable messages, time
 * out, and can be aborted with an AbortSignal (e.g. when an SSE client leaves).
 */
const https = require('https');

const HOST = 'api.anthropic.com';
const PATH = '/v1/messages';

function describeStatus(statusCode, data) {
  let errMsg = `Claude API returned HTTP ${statusCode}`;
  if (statusCode === 401) errMsg = 'Invalid API key — check your key at console.anthropic.com';
  else if (statusCode === 403) errMsg = 'API key lacks permission — check your key permissions';
  else if (statusCode === 429) errMsg = 'Rate limited — too many requests, wait a moment and retry';
  else if (statusCode === 500) errMsg = 'Claude API internal error — try again later';
  else if (statusCode === 529) errMsg = 'Claude API overloaded — try again in a few minutes';
  try {
    const parsed = JSON.parse(data);
    if (parsed.error?.message) errMsg += `: ${parsed.error.message}`;
  } catch {
    const titleMatch = String(data || '').match(/<title>(.*?)<\/title>/i);
    if (titleMatch) errMsg += ` (${titleMatch[1]})`;
    else if (data && data.length < 200) errMsg += ` — ${data.substring(0, 100)}`;
  }
  return errMsg;
}

function networkError(e) {
  if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return new Error('Request cancelled');
  if (e.code === 'ECONNRESET') return new Error('Connection to Claude API was reset — check your network');
  if (e.code === 'ENOTFOUND') return new Error('Cannot reach api.anthropic.com — check DNS/network');
  return new Error(`Network error calling Claude API: ${e.message}`);
}

function request(apiKey, body, { timeoutMs = 120000, signal, onResponse }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Request cancelled'));
    const payload = JSON.stringify(body);
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; cleanup(); fn(v); } };

    const apiReq = https.request({
      hostname: HOST, path: PATH, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (apiRes) => onResponse(apiRes, v => done(resolve, v), e => done(reject, e)));

    const onAbort = () => { apiReq.destroy(); done(reject, new Error('Request cancelled')); };
    const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    apiReq.setTimeout(timeoutMs, () => {
      apiReq.destroy();
      done(reject, new Error(`Claude API timed out after ${Math.round(timeoutMs / 1000)}s — the request may have been too large`));
    });
    apiReq.on('error', (e) => done(reject, networkError(e)));
    apiReq.write(payload);
    apiReq.end();
  });
}

function callClaudeAPI(apiKey, body, { timeoutMs = 120000, signal } = {}) {
  return request(apiKey, body, {
    timeoutMs, signal,
    onResponse(apiRes, resolve, reject) {
      let data = '';
      apiRes.setEncoding('utf8');
      apiRes.on('data', chunk => { data += chunk; });
      apiRes.on('error', e => reject(networkError(e)));
      apiRes.on('end', () => {
        if (apiRes.statusCode !== 200) return reject(new Error(describeStatus(apiRes.statusCode, data)));
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(`Claude API error: ${parsed.error.message}`));
          resolve(parsed);
        } catch {
          reject(new Error(`Failed to parse Claude response as JSON (got ${data.substring(0, 80)}…)`));
        }
      });
    },
  });
}

/** Streaming variant: onChunk(text) for each raw SSE chunk from the API. */
function claudeStream(apiKey, body, onChunk, { timeoutMs = 180000, signal } = {}) {
  return request(apiKey, { ...body, stream: true }, {
    timeoutMs, signal,
    onResponse(apiRes, resolve, reject) {
      apiRes.setEncoding('utf8');
      if (apiRes.statusCode !== 200) {
        let data = '';
        apiRes.on('data', c => { data += c; });
        apiRes.on('end', () => reject(new Error(describeStatus(apiRes.statusCode, data))));
        return;
      }
      apiRes.on('data', chunk => { try { onChunk(chunk); } catch {} });
      apiRes.on('error', e => reject(networkError(e)));
      apiRes.on('end', () => resolve());
    },
  });
}

module.exports = { callClaudeAPI, claudeStream, describeStatus };
