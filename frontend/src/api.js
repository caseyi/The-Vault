// Small fetch helpers that throw on non-2xx responses with the server's own
// error message (the backend answers errors as { error: '...' }), so callers
// can surface a human-readable notice instead of silently swallowing failures.

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function parseBody(res) {
  const hasHeaders = res.headers && typeof res.headers.get === 'function';
  const type = (hasHeaders && res.headers.get('content-type')) || '';
  if (!hasHeaders || type.includes('application/json') || typeof res.text !== 'function') {
    try { return await res.json(); } catch { return null; }
  }
  const text = await res.text().catch(() => '');
  try { return JSON.parse(text); } catch { return text; }
}

async function handle(res) {
  const body = await parseBody(res);
  if (res.ok === false) {
    const msg = (body && typeof body === 'object' && (body.error || body.message))
      || (typeof body === 'string' && body.trim() && body.trim().slice(0, 200))
      || `Request failed (${res.status})`;
    throw new ApiError(msg, res.status, body);
  }
  return body;
}

/** GET a JSON endpoint. Throws ApiError on HTTP errors. */
export async function apiGet(url, { signal } = {}) {
  const res = await fetch(url, signal ? { signal } : undefined);
  return handle(res);
}

/** Send JSON (POST/PATCH/PUT/DELETE). Throws ApiError on HTTP errors. */
export async function apiSend(url, method = 'POST', data, { signal, keepalive } = {}) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (data !== undefined) opts.body = JSON.stringify(data);
  if (signal) opts.signal = signal;
  if (keepalive) opts.keepalive = true;
  const res = await fetch(url, opts);
  return handle(res);
}

export function isAbortError(e) {
  return !!e && (e.name === 'AbortError' || e.code === 20);
}

export function errorMessage(e) {
  if (!e) return 'Unknown error';
  if (e instanceof ApiError) return e.message;
  if (e.message === 'Failed to fetch' || e.name === 'TypeError') return 'Could not reach the server';
  return e.message || String(e);
}
