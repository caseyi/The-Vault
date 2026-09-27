/**
 * Unit tests for backend/lib helpers: sse, middleware (async + origin), paths,
 * similar-name detection, shell quoting, AI job guard.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const request = require('supertest');

const { openSSE } = require('../lib/sse');
const { wrapAsyncRoutes, errorHandler } = require('../lib/middleware');
const { confinePath, isSafeSegment, isSafeImageUrl, PathError } = require('../lib/paths');
const { findSimilarNames, normalizeForSimilarity, isVariantOnlyName } = require('../lib/similar');
const { shellQuote, toHostPath } = require('../lib/shell');
const { acquireAiJob, currentAiJob } = require('../lib/jobs');

describe('lib/sse', () => {
  test('sets headers, sends heartbeats, flags client disconnect and fires onAbort', async () => {
    let sse;
    const aborted = new Promise(resolve => {
      const server = http.createServer((req, res) => {
        // minimal express-like shim for res.status()
        res.status = (c) => { res.statusCode = c; return res; };
        sse = openSSE(req, res, { heartbeatMs: 20 });
        sse.send({ hello: 1 });
        sse.onAbort(() => { server.close(); resolve(); });
      }).listen(0, '127.0.0.1', () => {
        const req = http.get(`http://127.0.0.1:${server.address().port}/`, (res) => {
          expect(res.headers['x-accel-buffering']).toBe('no');
          expect(res.headers['content-type']).toBe('text/event-stream');
          let buf = '';
          res.on('data', (d) => {
            buf += d;
            if (buf.includes('data: {"hello":1}') && buf.includes(':\n\n')) req.destroy();
          });
          res.on('error', () => {});
        });
        req.on('error', () => {});
      });
    });
    await aborted;
    expect(sse.aborted).toBe(true);
    expect(sse.signal.aborted).toBe(true);
    expect(sse.send({ late: true })).toBe(false); // writes after disconnect are no-ops
  });

  test('end() is a clean finish, not an abort', async () => {
    const app = express();
    let state;
    app.get('/', (req, res) => {
      const sse = openSSE(req, res);
      sse.end({ type: 'done' });
      state = sse;
    });
    const res = await request(app).get('/');
    expect(res.text).toBe('data: {"type":"done"}\n\n');
    expect(state.aborted).toBe(false);
    expect(state.ended).toBe(true);
  });
});

describe('lib/middleware asyncHandler', () => {
  test('a rejected async route becomes a JSON 500 instead of an unhandled rejection', async () => {
    const app = wrapAsyncRoutes(express());
    app.get('/boom', async () => { throw new Error('kaboom'); });
    app.get('/sse-boom', async (req, res) => { openSSE(req, res); await null; throw new Error('mid-stream'); });
    app.get('/path', async () => { throw new PathError('Path is outside the library', 403); });
    app.use(errorHandler);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let res = await request(app).get('/boom');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'kaboom' });
      res = await request(app).get('/sse-boom');
      expect(res.text).toMatch(/"success":false,"error":"mid-stream"/);
      res = await request(app).get('/path');
      expect(res.status).toBe(403);
      await new Promise(r => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      spy.mockRestore();
    }
  });

  test('app.get(setting) still works after wrapping', () => {
    const app = wrapAsyncRoutes(express());
    app.set('foo', 'bar');
    expect(app.get('foo')).toBe('bar');
  });
});

describe('lib/paths', () => {
  let root, lib;
  const saved = process.env.LIBRARY_PATH;
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paths-')));
    lib = path.join(root, 'lib');
    fs.mkdirSync(path.join(lib, 'A'), { recursive: true });
    fs.mkdirSync(path.join(root, 'out'));
    fs.symlinkSync(path.join(root, 'out'), path.join(lib, 'link'));
    process.env.LIBRARY_PATH = lib;
  });
  afterAll(() => { process.env.LIBRARY_PATH = saved; fs.rmSync(root, { recursive: true, force: true }); });

  test('accepts in-library paths, including not-yet-existing leaves', () => {
    expect(confinePath(lib)).toBe(lib);
    expect(confinePath(path.join(lib, 'A'))).toBe(path.join(lib, 'A'));
    expect(confinePath(path.join(lib, 'A', 'new', 'deeper'))).toBe(path.join(lib, 'A', 'new', 'deeper'));
  });

  test('rejects traversal, symlink escapes, siblings with a shared prefix, NUL and empty', () => {
    const bad = [path.join(lib, '..', 'out'), path.join(lib, 'link'), path.join(lib, 'link', 'x', 'y'), `${lib}-evil`, '/etc/passwd'];
    for (const p of bad) expect(() => confinePath(p)).toThrow(/outside the library/);
    expect(() => confinePath(`${lib}/a\0b`)).toThrow(PathError);
    expect(() => confinePath('')).toThrow(/required/);
  });

  test('segment + image-url validators', () => {
    for (const ok of ['Dragon', 'Group $(x)', "it's", 'v1.2']) expect(isSafeSegment(ok)).toBe(true);
    for (const bad of ['', ' ', '.', '..', 'a/b', 'a\\b', '../x', 'a\0', 'a\nb', 'x..y']) expect(isSafeSegment(bad)).toBe(false);
    expect(isSafeImageUrl('/images/u/a.png')).toBe(true);
    for (const bad of ['/images/../x', '/images/u/../../x', '/etc/passwd', 'images/x', '/images/a\\b']) expect(isSafeImageUrl(bad)).toBe(false);
  });
});

describe('lib/similar', () => {
  test('normalisation strips creator prefix, variants, dates, punctuation', () => {
    expect(normalizeForSimilarity('B3DSERK - Samurai Oni 2024-04 (copy)', 'B3DSERK Studios')).toBe('samurai oni');
    expect(normalizeForSimilarity('Wicked - Darth Vader Bust (Supported) v2', 'Wicked')).toBe('darth vader bust');
    expect(isVariantOnlyName('Pre-Supported')).toBe(true);
    expect(isVariantOnlyName('STL Files')).toBe(true);
    expect(isVariantOnlyName('Dragon')).toBe(false);
  });

  test('finds near-duplicates, ignores variant-only / short names, and stays fast', async () => {
    const models = [];
    let id = 1;
    // one creator with a shared "Creator - " prefix → used to all land in one bucket
    for (let i = 0; i < 15000; i++) {
      models.push({ id: id++, creator_id: 1 + (i % 30), creator_name: `Creator${i % 30}`, name: `Creator${i % 30} - ${['Knight', 'Dragon', 'Orc', 'Elf', 'Mech', 'Tank'][i % 6]} ${['Alpha', 'Bravo', 'Charlie', 'Delta'][i % 4]} Model ${i}` });
    }
    models.push({ id: id++, creator_id: 1, creator_name: 'Creator0', name: 'Creator0 - Samurai Oni 2024-04' });
    models.push({ id: id++, creator_id: 1, creator_name: 'Creator0', name: 'Creator0 - Samurai Oni 2024-04 (copy)' });
    models.push({ id: id++, creator_id: 2, creator_name: 'Creator1', name: 'Supported' });
    models.push({ id: id++, creator_id: 3, creator_name: 'Creator2', name: 'Supported' });
    const t0 = Date.now();
    const dupes = await findSimilarNames(models);
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(3000);
    expect(dupes.some(d => d.a.name.includes('Samurai') && d.b.name.includes('Samurai'))).toBe(true);
    expect(dupes.some(d => d.a.name === 'Supported')).toBe(false);
  });
});

describe('lib/shell', () => {
  test('shellQuote survives quotes and substitutions', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('$(rm -rf /)')).toBe(`'$(rm -rf /)'`);
  });

  test('toHostPath maps /library/<NAME> → LIBRARY_HOST_PATH, else legacy rewrite', () => {
    const saved = { ...process.env };
    try {
      delete process.env.LIBRARY_HOST_PATH;
      process.env.LIBRARY_PATH = '/library';
      expect(toHostPath('/library/STL Archive/A')).toBe('/volume1/STL Archive/A');
      process.env.LIBRARY_HOST_PATH = '/volume2/Prints';
      process.env.LIBRARY_NAME = 'STL Archive';
      expect(toHostPath('/library/STL Archive/A/B')).toBe('/volume2/Prints/A/B');
      expect(toHostPath('/library/STL Archive')).toBe('/volume2/Prints');
      expect(toHostPath('/library/Other/X')).toBe('/library/Other/X');
    } finally {
      for (const k of ['LIBRARY_HOST_PATH', 'LIBRARY_NAME', 'LIBRARY_PATH']) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }
  });
});

describe('lib/jobs', () => {
  test('one AI job at a time', () => {
    const r1 = acquireAiJob('a');
    expect(r1).toBeInstanceOf(Function);
    expect(acquireAiJob('b')).toBeNull();
    expect(currentAiJob().name).toBe('a');
    r1();
    r1(); // idempotent
    const r2 = acquireAiJob('b');
    expect(r2).toBeInstanceOf(Function);
    r2();
    expect(currentAiJob()).toBeNull();
  });
});
