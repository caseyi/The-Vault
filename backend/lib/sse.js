'use strict';
/**
 * lib/sse.js — one helper for every Server-Sent-Events endpoint.
 *
 *   const sse = openSSE(req, res);
 *   sse.send({ level: 'info', msg: 'hi' });   // data: {...}\n\n
 *   if (sse.aborted) break;                   // client went away — stop spending work/credits
 *   await sse.sleep(30000);                   // abortable wait (resolves early on disconnect)
 *   sse.end({ type: 'done', success: true }); // optional final event, then close
 *
 * Sets `X-Accel-Buffering: no` (nginx/Synology reverse proxies), sends a `:`
 * comment heartbeat every 15s so idle proxies don't cut the stream, and tracks
 * client disconnects. We listen on `res` 'close' (not `req` 'close'): since
 * Node 16 an IncomingMessage emits 'close' as soon as its body has been read,
 * which for POST streams is immediately — res 'close' fires on the real
 * connection teardown, and `writableFinished` tells us whether WE ended it.
 */

const HEARTBEAT_MS = 15000;

function openSSE(req, res, { heartbeatMs = HEARTBEAT_MS } = {}) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const controller = new AbortController();
  const abortListeners = [];
  let ended = false;
  let aborted = false;

  const write = (chunk) => {
    if (ended || aborted || res.writableEnded || res.destroyed) return false;
    try { return res.write(chunk); } catch { return false; }
  };

  const heartbeat = setInterval(() => write(':\n\n'), heartbeatMs);
  if (heartbeat.unref) heartbeat.unref();

  const cleanup = () => clearInterval(heartbeat);

  res.on('close', () => {
    cleanup();
    if (!ended && !res.writableFinished) {
      aborted = true;
      try { controller.abort(new Error('Client disconnected')); } catch {}
      for (const fn of abortListeners.splice(0)) { try { fn(); } catch {} }
    }
  });

  const sse = {
    get aborted() { return aborted; },
    get ended() { return ended; },
    /** AbortSignal that fires when the client disconnects (pass to fetch/https). */
    signal: controller.signal,
    send(data) { return write(`data: ${JSON.stringify(data)}\n\n`); },
    comment(text = '') { return write(`:${text}\n\n`); },
    /** Register a callback for client disconnect. */
    onAbort(fn) { if (aborted) { try { fn(); } catch {} } else abortListeners.push(fn); },
    /** Abortable sleep: resolves after ms, or immediately when the client leaves. */
    sleep(ms) {
      return new Promise(resolve => {
        if (aborted) return resolve();
        const t = setTimeout(resolve, ms);
        abortListeners.push(() => { clearTimeout(t); resolve(); });
      });
    },
    end(finalData) {
      if (ended) return;
      if (finalData !== undefined) sse.send(finalData);
      ended = true;
      cleanup();
      try { res.end(); } catch {}
    },
  };
  return sse;
}

module.exports = { openSSE, HEARTBEAT_MS };
