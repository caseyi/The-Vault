'use strict';
/**
 * lib/middleware.js — small Express helpers shared by server.js and organize.js.
 *
 *  asyncHandler(fn)   wrap an async route so a rejected promise reaches the
 *                     Express error handler instead of becoming an unhandled
 *                     rejection (which crashes Node 22).
 *  wrapAsyncRoutes(r) patch app/router .get/.post/... so EVERY handler is wrapped.
 *  originPolicy()     replaces app.use(cors()) with the ALLOWED_ORIGINS contract.
 *  errorHandler       final JSON error handler (SSE-aware).
 */
const { PathError } = require('./paths');

function asyncHandler(fn) {
  if (fn.length === 4) return fn; // error middleware — leave alone
  const wrapped = function (req, res, next) {
    let out;
    try { out = fn(req, res, next); } catch (e) { return next(e); }
    if (out && typeof out.then === 'function') out.then(undefined, next);
    return out;
  };
  Object.defineProperty(wrapped, 'name', { value: fn.name || 'asyncHandler' });
  return wrapped;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all'];
function wrapAsyncRoutes(router) {
  for (const m of METHODS) {
    const orig = router[m];
    if (typeof orig !== 'function') continue;
    router[m] = function (...args) {
      // app.get('setting') (1 string arg) is a settings getter on the app — pass through
      if (m === 'get' && args.length === 1 && typeof args[0] === 'string') return orig.apply(this, args);
      return orig.apply(this, args.map(a => (typeof a === 'function' ? asyncHandler(a) : a)));
    };
  }
  return router;
}

const DEFAULT_ORIGINS = 'tauri://localhost,http://tauri.localhost,https://tauri.localhost';

function hostnameOf(hostHeader) {
  if (!hostHeader) return null;
  const first = String(hostHeader).split(',')[0].trim();
  try { return new URL(`http://${first}`).hostname.toLowerCase(); } catch { return null; }
}

/**
 * Origin policy (CONTRACT.md):
 *  - no Origin header → allowed (curl, same-origin GETs, server-to-server)
 *  - same-origin (Origin hostname == Host or X-Forwarded-Host hostname, ports ignored) → allowed
 *  - Origin in ALLOWED_ORIGINS (comma list; default = Tauri origins) → allowed + CORS headers
 *  - ALLOWED_ORIGINS contains "*" → everything allowed (escape hatch)
 *  - anything else → 403
 */
function originPolicy() {
  const raw = process.env.ALLOWED_ORIGINS !== undefined ? process.env.ALLOWED_ORIGINS : DEFAULT_ORIGINS;
  const list = raw.split(',').map(s => s.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean);
  const any = list.includes('*');
  const allowed = new Set(list);

  return function originPolicyMiddleware(req, res, next) {
    const origin = req.headers.origin;
    if (!origin) return next();

    let ok = any;
    let originHost = null;
    try { originHost = new URL(origin).hostname.toLowerCase(); } catch {}
    if (!ok && originHost) {
      const hosts = [hostnameOf(req.headers.host), hostnameOf(req.headers['x-forwarded-host'])].filter(Boolean);
      if (hosts.includes(originHost)) ok = true;
    }
    if (!ok && allowed.has(String(origin).replace(/\/+$/, '').toLowerCase())) ok = true;

    if (!ok) {
      return res.status(403).json({ error: `Origin ${origin} is not allowed. Add it to ALLOWED_ORIGINS to permit it.` });
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.append('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type, x-claude-key, Accept');
      res.setHeader('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }
    next();
  };
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || (err instanceof PathError ? err.status : 500);
  if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}:`, err && err.stack ? err.stack : err);
  if (res.headersSent) {
    // Mid-stream (e.g. SSE) — tell the client and close.
    try {
      if (String(res.getHeader('Content-Type') || '').includes('text/event-stream')) {
        res.write(`data: ${JSON.stringify({ type: 'done', success: false, error: err.message || 'Internal error' })}\n\n`);
      }
    } catch {}
    try { res.end(); } catch {}
    return;
  }
  const body = err.type === 'entity.parse.failed' ? { error: 'Invalid JSON body' } : { error: err.message || 'Internal error' };
  res.status(status).json(body);
}

module.exports = { asyncHandler, wrapAsyncRoutes, originPolicy, errorHandler, DEFAULT_ORIGINS };
