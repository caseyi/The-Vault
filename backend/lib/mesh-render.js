'use strict';
/**
 * lib/mesh-render.js: a small pure-JS renderer for STL / OBJ / 3MF previews (docs/thumbnails.md §2.4).
 *
 * No native code and no GPU: a z-buffer rasterizer draws an orthographic 3/4 view at 2x the output
 * size (anti-aliasing by 2x2 averaging), shades it with a key + fill light, a soft screen-space
 * occlusion term and a little depth darkening, and encodes a PNG with the built-in zlib.
 *
 * Memory stays bounded: STL and OBJ are streamed (from a file or a zip entry) in two passes (bounds,
 * then raster). Up to MEM_TRIANGLES triangles are kept from the first pass so the second does not
 * read the source again; bigger meshes are simply streamed twice. 3MF is parsed once into indexed
 * arrays (vertices + triangles only).
 *
 * A source is { kind: 'file', path } | { kind: 'zip', zipPath, entry } | { kind: 'buffer', buf, name }.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const yauzl = require('yauzl');

// builtins as module constants: hot loops below stay fast in sandboxes that proxy globals (jest's vm)
const { sqrt: SQRT, pow: POW, max: MAX, min: MIN, round: ROUND, abs: ABS, floor: FLOOR, ceil: CEIL } = Math;
const NEG_INF = -Infinity;
const POS_INF = Infinity;
const isFin = Number.isFinite;
const MESH_EXTS = new Set(['.stl', '.obj', '.3mf']);
const MEM_TRIANGLES = 1500000;          // kept from pass 1 (36 bytes each)
const MAX_3MF_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_NESTED_3MF_BYTES = 200 * 1024 * 1024;

// ── sources ──────────────────────────────────────────────────────────────────

function extOf(src) {
  const name = src.kind === 'zip' ? src.entry : (src.kind === 'buffer' ? src.name : src.path);
  return path.extname(String(name || '')).toLowerCase();
}

function openZipFile(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: true, strictFileNames: false, validateEntrySizes: true }, (e, zf) => (e ? reject(e) : resolve(zf)));
  });
}
function openZipBuffer(buf) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true, decodeStrings: true, strictFileNames: false, validateEntrySizes: true }, (e, zf) => (e ? reject(e) : resolve(zf)));
  });
}
/** Every entry of an open zip: [{ name, size, entry }]. */
function zipEntries(zf) {
  return new Promise((resolve, reject) => {
    const out = [];
    zf.on('entry', (e) => { out.push({ name: String(e.fileName).replace(/\\/g, '/'), size: e.uncompressedSize, entry: e }); zf.readEntry(); });
    zf.once('end', () => resolve(out));
    zf.once('error', reject);
    zf.readEntry();
  });
}
function entryStream(zf, entry) {
  return new Promise((resolve, reject) => zf.openReadStream(entry, (e, rs) => (e ? reject(e) : resolve(rs))));
}
async function readStreamToBuffer(rs, max) {
  const parts = [];
  let n = 0;
  for await (const c of rs) {
    n += c.length;
    if (n > max) { rs.destroy(); throw new Error('entry too large'); }
    parts.push(c);
  }
  return Buffer.concat(parts, n);
}

/** Open a byte stream for a STL/OBJ source: { stream, size, close() }. */
async function openSourceStream(src) {
  if (src.kind === 'file') {
    const st = fs.statSync(src.path);
    return { stream: fs.createReadStream(src.path, { highWaterMark: 1 << 20 }), size: st.size, close() {} };
  }
  if (src.kind === 'buffer') {
    const { Readable } = require('stream');
    return { stream: Readable.from([src.buf]), size: src.buf.length, close() {} };
  }
  if (src.kind === 'zip') {
    const zf = await openZipFile(src.zipPath);
    try {
      const all = await zipEntries(zf);
      const hit = all.find(e => e.name === src.entry);
      if (!hit) throw new Error(`entry not found: ${src.entry}`);
      const rs = await entryStream(zf, hit.entry);
      return { stream: rs, size: hit.size, close() { try { zf.close(); } catch {} } };
    } catch (e) { try { zf.close(); } catch {} throw e; }
  }
  throw new Error(`unknown source kind ${src.kind}`);
}

// ── STL ──────────────────────────────────────────────────────────────────────

/**
 * Stream a STL's triangles to cb(ax,ay,az,bx,by,bz,cx,cy,cz). Returns the triangle count.
 * Binary when the header's count matches the size (or the file does not start with "solid").
 */
async function streamStl(src, cb, opts = {}) {
  const { stream, size, close } = await openSourceStream(src);
  const limit = opts.limit || Infinity;
  let count = 0;
  try {
    let head = Buffer.alloc(0);
    let mode = null;
    let rest = null;      // binary: leftover bytes; ascii: leftover text
    const vb = new Float64Array(9);
    let vi = 0;
    const binChunk = (buf) => {
      let off = 0;
      if (rest && rest.length) { buf = Buffer.concat([rest, buf]); rest = null; }
      const n = Math.floor(buf.length / 50);
      for (let i = 0; i < n && count < limit; i++, off += 50) {
        cb(buf.readFloatLE(off + 12), buf.readFloatLE(off + 16), buf.readFloatLE(off + 20),
          buf.readFloatLE(off + 24), buf.readFloatLE(off + 28), buf.readFloatLE(off + 32),
          buf.readFloatLE(off + 36), buf.readFloatLE(off + 40), buf.readFloatLE(off + 44));
        count++;
      }
      if (off < buf.length) rest = buf.subarray(off);
    };
    const asciiLine = (line) => {
      let i = 0;
      while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
      if (line.startsWith('vertex', i)) {
        const parts = line.slice(i + 6).trim().split(/\s+/);
        vb[vi * 3] = +parts[0]; vb[vi * 3 + 1] = +parts[1]; vb[vi * 3 + 2] = +parts[2];
        vi++;
        if (vi === 3) {
          if (count < limit) cb(vb[0], vb[1], vb[2], vb[3], vb[4], vb[5], vb[6], vb[7], vb[8]);
          count++;
          // a polygon with more than 3 vertices: fan around the first
          vb[3] = vb[6]; vb[4] = vb[7]; vb[5] = vb[8]; vi = 2;
        }
      } else if (line.startsWith('endloop', i) || line.startsWith('facet', i)) vi = 0;
    };
    const asciiChunk = (buf) => {
      const text = (rest || '') + buf.toString('latin1');
      let start = 0;
      for (;;) {
        const nl = text.indexOf('\n', start);
        if (nl < 0) break;
        asciiLine(text.slice(start, nl));
        start = nl + 1;
      }
      rest = text.slice(start);
      if (rest.length > 1 << 20) rest = ''; // no newline in 1 MB: not a text STL
    };
    for await (const chunk of stream) {
      if (count >= limit) break;
      if (!mode) {
        head = Buffer.concat([head, chunk]);
        if (head.length < 84 && head.length < size) continue;
        const n = head.length >= 84 ? head.readUInt32LE(80) : -1;
        const startsSolid = /^\s*solid/i.test(head.subarray(0, Math.min(head.length, 80)).toString('latin1'));
        if (n >= 0 && size === 84 + n * 50) mode = 'bin';
        else if (startsSolid) mode = 'ascii';
        else mode = 'bin';
        if (mode === 'bin') { if (head.length > 84) binChunk(head.subarray(84)); } else asciiChunk(head);
        head = null;
        continue;
      }
      if (mode === 'bin') binChunk(chunk); else asciiChunk(chunk);
    }
    if (mode === 'ascii' && rest) asciiLine(rest);
  } finally {
    try { stream.destroy(); } catch {}
    close();
  }
  return count;
}

// ── OBJ ──────────────────────────────────────────────────────────────────────

async function streamObj(src, cb, opts = {}) {
  const { stream, close } = await openSourceStream(src);
  const limit = opts.limit || Infinity;
  let verts = new Float32Array(3 * 65536);
  let nv = 0;
  let count = 0;
  const vertex = (k) => {
    let i = parseInt(k, 10);
    if (!Number.isFinite(i) || i === 0) return -1;
    i = i < 0 ? nv + i : i - 1;
    return i >= 0 && i < nv ? i : -1;
  };
  const line = (l) => {
    const c0 = l.charCodeAt(0), c1 = l.charCodeAt(1);
    if (c0 === 118 /* v */ && (c1 === 32 || c1 === 9)) {
      const p = l.slice(2).trim().split(/\s+/);
      if (nv * 3 + 3 > verts.length) { const nb = new Float32Array(verts.length * 2); nb.set(verts); verts = nb; }
      verts[nv * 3] = +p[0]; verts[nv * 3 + 1] = +p[1]; verts[nv * 3 + 2] = +p[2];
      nv++;
    } else if (c0 === 102 /* f */ && (c1 === 32 || c1 === 9)) {
      const p = l.slice(2).trim().split(/\s+/);
      const idx = p.map(t => vertex(t.split('/')[0]));
      if (idx.some(i => i < 0)) return;
      for (let k = 1; k + 1 < idx.length; k++) {
        if (count >= limit) return;
        const a = idx[0] * 3, b = idx[k] * 3, c = idx[k + 1] * 3;
        cb(verts[a], verts[a + 1], verts[a + 2], verts[b], verts[b + 1], verts[b + 2], verts[c], verts[c + 1], verts[c + 2]);
        count++;
      }
    }
  };
  try {
    let rest = '';
    for await (const chunk of stream) {
      const text = rest + chunk.toString('latin1');
      let start = 0;
      for (;;) {
        const nl = text.indexOf('\n', start);
        if (nl < 0) break;
        line(text.slice(start, nl));
        start = nl + 1;
      }
      rest = text.slice(start);
      if (count >= limit) break;
    }
    if (rest) line(rest);
  } finally {
    try { stream.destroy(); } catch {}
    close();
  }
  return count;
}

// ── 3MF ──────────────────────────────────────────────────────────────────────

const attr = (tag, name) => {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`);
  const m = re.exec(tag);
  return m ? m[1] : null;
};
const attrAny = (tag, local) => {
  // namespaced attributes (p:path) — match by local name
  const re = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${local}\\s*=\\s*"([^"]*)"`);
  const m = re.exec(tag);
  return m ? m[1] : null;
};
function parseTransform(s) {
  if (!s) return null;
  const v = s.trim().split(/\s+/).map(Number);
  return v.length === 12 && v.every(Number.isFinite) ? v : null;
}
// 3MF matrices are row-vector: p' = p * M (m00 m01 m02 / m10 .. / m20 .. / m30 m31 m32 translation)
function mulT(a, b) { // apply a then b
  if (!a) return b; if (!b) return a;
  const r = new Array(12);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      let s = (i === 3 ? b[9 + j] : 0);
      for (let k = 0; k < 3; k++) s += a[i * 3 + k] * b[k * 3 + j];
      r[i * 3 + j] = s;
    }
  }
  return r;
}

/** Stream-parse one .model XML: objects (meshes, components) and build items. */
async function parse3mfModel(stream, file, objects, items) {
  let rest = '';
  let cur = null;          // current object
  let verts = null, nv = 0, tris = null, nt = 0;
  const pushV = (x, y, z) => {
    if (nv * 3 + 3 > verts.length) { const nb = new Float32Array(verts.length * 2); nb.set(verts); verts = nb; }
    verts[nv * 3] = x; verts[nv * 3 + 1] = y; verts[nv * 3 + 2] = z; nv++;
  };
  const pushT = (a, b, c) => {
    if (nt * 3 + 3 > tris.length) { const nb = new Uint32Array(tris.length * 2); nb.set(tris); tris = nb; }
    tris[nt * 3] = a; tris[nt * 3 + 1] = b; tris[nt * 3 + 2] = c; nt++;
  };
  const tag = (t) => {
    // t is the inside of <...>
    if (t[0] === '?' || t[0] === '!') return;
    const closing = t[0] === '/';
    const body = closing ? t.slice(1) : t;
    const sp = body.search(/[\s/]/);
    let name = sp < 0 ? body : body.slice(0, sp);
    const colon = name.indexOf(':');
    if (colon >= 0) name = name.slice(colon + 1);
    if (name === 'vertex' && !closing) {
      pushV(+attr(body, 'x'), +attr(body, 'y'), +attr(body, 'z'));
    } else if (name === 'triangle' && !closing) {
      pushT(+attr(body, 'v1'), +attr(body, 'v2'), +attr(body, 'v3'));
    } else if (name === 'object') {
      if (closing) {
        if (cur) {
          if (verts && nv && nt) cur.mesh = { verts: verts.subarray(0, nv * 3), tris: tris.subarray(0, nt * 3) };
          objects.set(`${file}#${cur.id}`, cur);
        }
        cur = null; verts = null;
      } else {
        cur = { id: attr(body, 'id'), file, mesh: null, components: [] };
        if (/\/\s*$/.test(body)) { objects.set(`${file}#${cur.id}`, cur); cur = null; }
      }
    } else if (name === 'mesh' && !closing) {
      verts = new Float32Array(3 * 4096); nv = 0; tris = new Uint32Array(3 * 4096); nt = 0;
    } else if (name === 'component' && !closing && cur) {
      cur.components.push({ objectid: attr(body, 'objectid'), path: attrAny(body, 'path'), transform: parseTransform(attr(body, 'transform')) });
    } else if (name === 'item' && !closing) {
      items.push({ file, objectid: attr(body, 'objectid'), path: attrAny(body, 'path'), transform: parseTransform(attr(body, 'transform')) });
    }
  };
  for await (const chunk of stream) {
    const text = rest + chunk.toString('utf8');
    let i = 0;
    for (;;) {
      const lt = text.indexOf('<', i);
      if (lt < 0) { i = text.length; break; }
      const gt = text.indexOf('>', lt);
      if (gt < 0) { i = lt; break; }
      tag(text.slice(lt + 1, gt));
      i = gt + 1;
    }
    rest = text.slice(i);
  }
}

/** Parse a 3MF (zip file or buffer) into a list of { verts, tris, transform } instances. */
async function load3mf(src) {
  let zf;
  if (src.kind === 'file') zf = await openZipFile(src.path);
  else if (src.kind === 'buffer') zf = await openZipBuffer(src.buf);
  else {
    // a 3MF inside a card's zip: read it into memory (bounded), then open that
    const outer = await openZipFile(src.zipPath);
    let buf;
    try {
      const hit = (await zipEntries(outer)).find(e => e.name === src.entry);
      if (!hit) throw new Error(`entry not found: ${src.entry}`);
      if (hit.size > MAX_NESTED_3MF_BYTES) throw new Error('3MF inside the archive is too large');
      buf = await readStreamToBuffer(await entryStream(outer, hit.entry), MAX_NESTED_3MF_BYTES);
    } finally { try { outer.close(); } catch {} }
    zf = await openZipBuffer(buf);
  }
  const objects = new Map();
  const items = [];
  try {
    const entries = (await zipEntries(zf)).filter(e => /\.model$/i.test(e.name) && e.size <= MAX_3MF_ENTRY_BYTES);
    for (const e of entries) {
      const file = '/' + e.name.replace(/^\/+/, '');
      await parse3mfModel(await entryStream(zf, e.entry), file, objects, items);
    }
  } finally { try { zf.close(); } catch {} }
  const out = [];
  const resolve = (file, id, pth, t, depth) => {
    if (depth > 8) return;
    const key = `${pth ? '/' + String(pth).replace(/^\/+/, '') : file}#${id}`;
    const o = objects.get(key);
    if (!o) return;
    if (o.mesh) out.push({ ...o.mesh, transform: t });
    for (const c of o.components) resolve(o.file, c.objectid, c.path, mulT(c.transform, t), depth + 1);
  };
  const buildItems = items.filter(it => /3dmodel\.model$/i.test(it.file));
  for (const it of (buildItems.length ? buildItems : items)) resolve(it.file, it.objectid, it.path, it.transform, 0);
  if (!out.length) for (const o of objects.values()) if (o.mesh) out.push({ ...o.mesh, transform: null });
  return out;
}

async function stream3mf(src, cb, opts = {}) {
  if (!src._3mf) src._3mf = await load3mf(src);
  const limit = opts.limit || Infinity;
  let count = 0;
  for (const inst of src._3mf) {
    const { verts, tris, transform: m } = inst;
    const nv = verts.length / 3;
    const tv = m ? new Float32Array(verts.length) : verts;
    if (m) {
      for (let i = 0; i < nv; i++) {
        const x = verts[i * 3], y = verts[i * 3 + 1], z = verts[i * 3 + 2];
        tv[i * 3] = x * m[0] + y * m[3] + z * m[6] + m[9];
        tv[i * 3 + 1] = x * m[1] + y * m[4] + z * m[7] + m[10];
        tv[i * 3 + 2] = x * m[2] + y * m[5] + z * m[8] + m[11];
      }
    }
    for (let t = 0; t < tris.length; t += 3) {
      if (count >= limit) return count;
      const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
      if (a + 2 >= tv.length || b + 2 >= tv.length || c + 2 >= tv.length) continue;
      cb(tv[a], tv[a + 1], tv[a + 2], tv[b], tv[b + 1], tv[b + 2], tv[c], tv[c + 1], tv[c + 2]);
      count++;
    }
  }
  return count;
}

/** Stream the triangles of any supported source. */
function forEachTriangle(src, cb, opts) {
  const ext = extOf(src);
  if (ext === '.stl') return streamStl(src, cb, opts);
  if (ext === '.obj') return streamObj(src, cb, opts);
  if (ext === '.3mf') return stream3mf(src, cb, opts);
  return Promise.reject(new Error(`unsupported mesh type ${ext || '(none)'}`));
}

// ── view ─────────────────────────────────────────────────────────────────────

const DEG = Math.PI / 180;
function viewBasis(azimuthDeg = 35, elevationDeg = 24) {
  const th = azimuthDeg * DEG, ph = elevationDeg * DEG;
  // camera direction (from the model toward the camera), Z up, front of the model at -Y
  const d = [Math.sin(th) * Math.cos(ph), -Math.cos(th) * Math.cos(ph), Math.sin(ph)];
  const f = [-d[0], -d[1], -d[2]];
  let r = [f[1] * 1 - f[2] * 0, f[2] * 0 - f[0] * 1, 0]; // f x up(0,0,1)
  const rl = Math.hypot(r[0], r[1], r[2]); r = r.map(v => v / rl);
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  return { r, u, d };
}

/**
 * Rotations that turn each possible "down" direction into -Z (Z-up world for the view), as rows:
 * p' = (M[0]·p, M[1]·p, M[2]·p). Order: -X, +X, -Y, +Y, -Z, +Z. All proper rotations (det 1).
 */
const DOWN_MATS = [
  [[0, 0, -1], [0, 1, 0], [1, 0, 0]],   // -X down: (x,y,z) → (-z, y, x)
  [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],   // +X down: → (z, y, -x)
  [[1, 0, 0], [0, 0, -1], [0, 1, 0]],   // -Y down (Y-up model): → (x, -z, y)
  [[1, 0, 0], [0, 0, 1], [0, -1, 0]],   // +Y down: → (x, z, -y)
  [[1, 0, 0], [0, 1, 0], [0, 0, 1]],    // -Z down (slicer convention)
  [[1, 0, 0], [0, -1, 0], [0, 0, -1]],  // +Z down (upside down): → (x, -y, -z)
];
const DOWN_NAMES = ['-x', '+x', '-y', '+y', '-z', '+z'];

// ── PNG ──────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** Encode RGB (Uint8Array w*h*3) as PNG; per row the cheapest of None/Sub/Up filters. */
function encodePng(rgb, w, h) {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 3; f++) {
      const out = cand[f];
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const x = rgb[row + i];
        const a = i >= 3 ? rgb[row + i - 3] : 0;
        const b = y > 0 ? rgb[row - stride + i] : 0;
        const v = f === 0 ? x : (f === 1 ? (x - a) & 255 : (x - b) & 255);
        out[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    const o = y * (stride + 1);
    raw[o] = best;
    cand[best].copy(raw, o + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Decode the PNGs encodePng writes (8-bit RGB, filters 0-4). For tests and checks. */
function decodePng(buf) {
  let off = 8, w = 0, h = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); if (data[8] !== 8 || data[9] !== 2) throw new Error('only 8-bit RGB'); }
    else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 3;
  const out = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= 3 ? out[y * stride + i - 3] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = i >= 3 && y > 0 ? out[(y - 1) * stride + i - 3] : 0;
      let v;
      if (f === 0) v = x; else if (f === 1) v = x + a; else if (f === 2) v = x + b; else if (f === 3) v = x + ((a + b) >> 1);
      else { const p = a + b - c; const pa = ABS(p - a), pb = ABS(p - b), pc = ABS(p - c); v = x + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c)); }
      out[y * stride + i] = v & 255;
    }
  }
  return { width: w, height: h, data: out };
}

// ── render ───────────────────────────────────────────────────────────────────

/**
 * Render one or more mesh sources (drawn together, e.g. the parts of one model) to a PNG.
 * @param {object[]} sources
 * @param {{ size?: number, supersample?: number, maxTriangles?: number, upAxis?: 'auto'|'z'|'y', shouldStop?: () => boolean }} [opts]
 * @returns {Promise<{ png: Buffer, width: number, height: number, triangles: number, drawn: number, coverage: number, upAxis: string, ms: { read: number, raster: number, shade: number, encode: number, total: number } }>}
 */
async function renderMeshes(sources, opts = {}) {
  const t0 = Date.now();
  const size = opts.size || 640;
  const ss = opts.supersample || 2;
  const W = size * ss, H = size * ss;
  const maxTris = opts.maxTriangles || POS_INF;
  const { r, u, d } = viewBasis(opts.azimuth, opts.elevation);
  const memCap = opts.memTriangles || MEM_TRIANGLES;

  // pass 1: bounds (world, per source, and in view space for each of the 6 "down" directions),
  // the axis-facing triangles for the flat-bottom detector, plus an in-memory copy
  let mem = new Float32Array(9 * 65536);
  let memN = 0;
  let memOk = true;
  let total = 0;
  const wb = [POS_INF, POS_INF, POS_INF, NEG_INF, NEG_INF, NEG_INF];
  // per orientation k: combined basis (view · M_k) as 9 numbers, and view bounds [min xyz, max xyz]
  const OB = new Float64Array(54);
  for (let k = 0; k < 6; k++) {
    const M = DOWN_MATS[k];
    for (let v = 0; v < 3; v++) {
      const axis = v === 0 ? r : (v === 1 ? u : d);
      for (let c = 0; c < 3; c++) OB[k * 9 + v * 3 + c] = axis[0] * M[0][c] + axis[1] * M[1][c] + axis[2] * M[2][c];
    }
  }
  const VB = new Float64Array(36);
  for (let k = 0; k < 6; k++) { VB[k * 6] = VB[k * 6 + 1] = VB[k * 6 + 2] = POS_INF; VB[k * 6 + 3] = VB[k * 6 + 4] = VB[k * 6 + 5] = NEG_INF; }
  // flat-bottom detector records: triangles facing an axis (|n·axis| > 0.95)
  const FLAT_CAP = 2000000;
  let flatN = 0;
  let fSrc = new Uint16Array(65536), fAxis = new Uint8Array(65536), fLo = new Float32Array(65536), fHi = new Float32Array(65536), fArea = new Float32Array(65536);
  const srcBox = [], srcArea = [];
  let si = 0;
  let sb = null;
  const vert = (x, y, z) => {
    if (x < sb[0]) sb[0] = x; if (y < sb[1]) sb[1] = y; if (z < sb[2]) sb[2] = z;
    if (x > sb[3]) sb[3] = x; if (y > sb[4]) sb[4] = y; if (z > sb[5]) sb[5] = z;
    for (let k = 0, o = 0, q = 0; k < 6; k++, o += 9, q += 6) {
      const sx = x * OB[o] + y * OB[o + 1] + z * OB[o + 2], sy = x * OB[o + 3] + y * OB[o + 4] + z * OB[o + 5], sz = x * OB[o + 6] + y * OB[o + 7] + z * OB[o + 8];
      if (sx < VB[q]) VB[q] = sx; if (sy < VB[q + 1]) VB[q + 1] = sy; if (sz < VB[q + 2]) VB[q + 2] = sz;
      if (sx > VB[q + 3]) VB[q + 3] = sx; if (sy > VB[q + 4]) VB[q + 4] = sy; if (sz > VB[q + 5]) VB[q + 5] = sz;
    }
  };
  const flat = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const len = SQRT(nx * nx + ny * ny + nz * nz);
    if (!(len > 0)) return;
    srcArea[si] += len / 2;
    let axis = -1, lo = 0, hi = 0;
    if (ABS(nz) > 0.95 * len) { axis = 2; lo = MIN(az, bz, cz); hi = MAX(az, bz, cz); }
    else if (ABS(ny) > 0.95 * len) { axis = 1; lo = MIN(ay, by, cy); hi = MAX(ay, by, cy); }
    else if (ABS(nx) > 0.95 * len) { axis = 0; lo = MIN(ax, bx, cx); hi = MAX(ax, bx, cx); }
    if (axis < 0 || flatN >= FLAT_CAP) return;
    if (flatN === fSrc.length) {
      const grow = (A) => { const nb = new A.constructor(A.length * 2); nb.set(A); return nb; };
      fSrc = grow(fSrc); fAxis = grow(fAxis); fLo = grow(fLo); fHi = grow(fHi); fArea = grow(fArea);
    }
    fSrc[flatN] = si; fAxis[flatN] = axis; fLo[flatN] = lo; fHi[flatN] = hi; fArea[flatN] = len / 2;
    flatN++;
  };
  const used = [];
  for (const src of sources) {
    if (opts.shouldStop && opts.shouldStop()) throw new Error('stopped');
    if (total >= maxTris) break;
    si = used.length;
    sb = [POS_INF, POS_INF, POS_INF, NEG_INF, NEG_INF, NEG_INF];
    srcBox[si] = sb; srcArea[si] = 0;
    const n = await forEachTriangle(src, (ax, ay, az, bx, by, bz, cx, cy, cz) => {
      if (!(isFin(ax + ay + az + bx + by + bz + cx + cy + cz))) return;
      vert(ax, ay, az); vert(bx, by, bz); vert(cx, cy, cz);
      flat(ax, ay, az, bx, by, bz, cx, cy, cz);
      if (memOk) {
        if ((memN + 1) * 9 > mem.length) {
          if (mem.length / 9 >= memCap) { memOk = false; mem = null; return; }
          const nb = new Float32Array(MIN(mem.length * 2, memCap * 9)); nb.set(mem); mem = nb;
        }
        const o = memN * 9;
        mem[o] = ax; mem[o + 1] = ay; mem[o + 2] = az; mem[o + 3] = bx; mem[o + 4] = by; mem[o + 5] = bz; mem[o + 6] = cx; mem[o + 7] = cy; mem[o + 8] = cz;
        memN++;
      }
    }, { limit: maxTris - total });
    total += n;
    used.push(src);
    for (let c = 0; c < 3; c++) { if (sb[c] < wb[c]) wb[c] = sb[c]; if (sb[c + 3] > wb[c + 3]) wb[c + 3] = sb[c + 3]; }
  }
  if (!isFin(wb[0]) || total === 0) throw new Error('no triangles in the mesh');
  const tRead = Date.now();

  // parts that are not an assembly (laid out side by side on a plate, a figure next to its base):
  // render only the largest one, with its own up axis
  if (used.length > 1 && opts.assemblyCheck !== false) {
    const which = assemblyCheck(used, srcBox, srcArea);
    if (!which.assembly) {
      mem = null;
      const res = await renderMeshes([used[which.main]], { ...opts, assemblyCheck: false, maxTriangles: POS_INF });
      return { ...res, parts: [sources.indexOf(used[which.main])], assembly: false, ms: { ...res.ms, total: Date.now() - t0 } };
    }
  }

  // which way is down: the flat bottom of the largest part (sources are drawn together)
  let main = 0;
  for (let k = 1; k < used.length; k++) if (srcArea[k] > srcArea[main]) main = k;
  const down = new Float64Array(6); // -X +X -Y +Y -Z +Z
  {
    const b = srcBox[main];
    for (let i = 0; i < flatN; i++) {
      if (fSrc[i] !== main) continue;
      const a = fAxis[i];
      const tol = 0.02 * (b[a + 3] - b[a]);
      if (fHi[i] - b[a] <= tol) down[2 * a] += fArea[i];
      if (b[a + 3] - fLo[i] <= tol) down[2 * a + 1] += fArea[i];
    }
  }
  let k = 4;
  if (opts.upAxis === 'z') k = 4;
  else if (opts.upAxis === 'y') k = 2;
  else {
    let best = 4;
    for (let q = 0; q < 6; q++) if (down[q] > down[best]) best = q;
    // slicer convention wins when it already stands on a sizeable flat face (blocks, plates, busts
    // on square plinths); otherwise the largest flat face at an extreme is the bottom
    // a clear winner only: at least 1% of the surface and 1.5x any other direction (curved
    // surfaces have small near-flat patches at every extreme: a tie)
    let second = 0;
    for (let q = 0; q < 6; q++) if (q !== best && down[q] > second) second = down[q];
    if (down[best] >= 0.01 * (srcArea[main] || 1) && down[best] >= 1.5 * second && down[4] < 0.5 * down[best]) k = best;
  }
  const up = k >> 1 === 0 ? 'x' : (k >> 1 === 1 ? 'y' : 'z');
  const ob = k * 9;
  const r0 = OB[ob], r1 = OB[ob + 1], r2 = OB[ob + 2], u0 = OB[ob + 3], u1 = OB[ob + 4], u2 = OB[ob + 5], d0 = OB[ob + 6], d1 = OB[ob + 7], d2 = OB[ob + 8];
  const vb = Array.from(VB.subarray(k * 6, k * 6 + 6));
  const spanX = vb[3] - vb[0], spanY = vb[4] - vb[1];
  const span = MAX(spanX, spanY) || 1;
  const margin = 0.08;
  const scale = (W * (1 - 2 * margin)) / span;
  const cxv = (vb[0] + vb[3]) / 2, cyv = (vb[1] + vb[4]) / 2;
  const zmin = vb[2], zmax = vb[5];
  fSrc = fAxis = fLo = fHi = fArea = null;

  // pass 2: raster (depth + view-space normal per sample)
  const N = W * H;
  const depth = new Float32Array(N).fill(NEG_INF);
  const nrm = new Int8Array(N * 3);
  let drawn = 0;
  const halfW = W / 2, halfH = H / 2;
  const tri = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    // view space
    const sax = ax * r0 + ay * r1 + az * r2, say = ax * u0 + ay * u1 + az * u2, saz = ax * d0 + ay * d1 + az * d2;
    const sbx = bx * r0 + by * r1 + bz * r2, sby = bx * u0 + by * u1 + bz * u2, sbz = bx * d0 + by * d1 + bz * d2;
    const scx = cx * r0 + cy * r1 + cz * r2, scy = cx * u0 + cy * u1 + cz * u2, scz = cx * d0 + cy * d1 + cz * d2;
    if (!(isFin(sax + sbx + scx + say + sby + scy))) return;
    // normal (view space, x right, y up, z toward the camera); two-sided
    const e1x = sbx - sax, e1y = sby - say, e1z = sbz - saz, e2x = scx - sax, e2y = scy - say, e2z = scz - saz;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const nl = SQRT(nx * nx + ny * ny + nz * nz);
    if (!(nl > 0)) return;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const qx = ROUND(nx / nl * 127), qy = ROUND(ny / nl * 127), qz = ROUND(nz / nl * 127);
    // pixels
    const X0 = (sax - cxv) * scale + halfW, Y0 = halfH - (say - cyv) * scale;
    const X1 = (sbx - cxv) * scale + halfW, Y1 = halfH - (sby - cyv) * scale;
    const X2 = (scx - cxv) * scale + halfW, Y2 = halfH - (scy - cyv) * scale;
    let minx = CEIL(MIN(X0, X1, X2) - 0.5), maxx = FLOOR(MAX(X0, X1, X2) - 0.5);
    let miny = CEIL(MIN(Y0, Y1, Y2) - 0.5), maxy = FLOOR(MAX(Y0, Y1, Y2) - 0.5);
    if (minx < 0) minx = 0; if (miny < 0) miny = 0; if (maxx > W - 1) maxx = W - 1; if (maxy > H - 1) maxy = H - 1;
    if (minx > maxx || miny > maxy) return;
    const area = (X1 - X0) * (Y2 - Y0) - (X2 - X0) * (Y1 - Y0);
    if (area === 0) return;
    const inv = 1 / area;
    // edge functions at the first sample centre, stepped incrementally
    const px0 = minx + 0.5, py0 = miny + 0.5;
    const A0 = (Y1 - Y2) * inv, B0 = (X2 - X1) * inv;   // w0 (opposite vertex 0)
    const A1 = (Y2 - Y0) * inv, B1 = (X0 - X2) * inv;
    const A2 = (Y0 - Y1) * inv, B2 = (X1 - X0) * inv;
    let w0row = ((X2 - X1) * (py0 - Y1) - (Y2 - Y1) * (px0 - X1)) * inv;
    let w1row = ((X0 - X2) * (py0 - Y2) - (Y0 - Y2) * (px0 - X2)) * inv;
    let w2row = ((X1 - X0) * (py0 - Y0) - (Y1 - Y0) * (px0 - X0)) * inv;
    const EPS = -1e-7;
    for (let y = miny; y <= maxy; y++) {
      let w0 = w0row, w1 = w1row, w2 = w2row;
      let idx = y * W + minx;
      for (let x = minx; x <= maxx; x++, idx++) {
        if (w0 >= EPS && w1 >= EPS && w2 >= EPS) {
          const z = w0 * saz + w1 * sbz + w2 * scz;
          if (z > depth[idx]) {
            depth[idx] = z;
            const k = idx * 3;
            nrm[k] = qx; nrm[k + 1] = qy; nrm[k + 2] = qz;
          }
        }
        w0 += A0; w1 += A1; w2 += A2;
      }
      w0row += B0; w1row += B1; w2row += B2;
    }
    drawn++;
  };
  if (memOk && mem) {
    for (let i = 0, o = 0; i < memN; i++, o += 9) tri(mem[o], mem[o + 1], mem[o + 2], mem[o + 3], mem[o + 4], mem[o + 5], mem[o + 6], mem[o + 7], mem[o + 8]);
    mem = null;
  } else {
    let left = total;
    for (const src of used) {
      if (opts.shouldStop && opts.shouldStop()) throw new Error('stopped');
      if (left <= 0) break;
      left -= await forEachTriangle(src, (ax, ay, az, bx, by, bz, cx, cy, cz) => {
        if (!(isFin(ax + ay + az + bx + by + bz + cx + cy + cz))) return;
        tri(ax, ay, az, bx, by, bz, cx, cy, cz);
      }, { limit: left });
    }
  }
  const tRaster = Date.now();

  const rgbHi = shade({ W, H, depth, nrm, scale, zmin, zmax });
  // coverage (share of samples hit) for sanity checks
  let hit = 0;
  for (let i = 0; i < N; i++) if (depth[i] > NEG_INF) hit++;
  if (!hit) throw new Error('the mesh did not cover any pixel');
  const tShade = Date.now();

  // 2x2 (ss x ss) box downsample
  const rgb = new Uint8Array(size * size * 3);
  const area = ss * ss;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let R = 0, G = 0, B = 0;
      for (let j = 0; j < ss; j++) {
        let k = ((y * ss + j) * W + x * ss) * 3;
        for (let i = 0; i < ss; i++, k += 3) { R += rgbHi[k]; G += rgbHi[k + 1]; B += rgbHi[k + 2]; }
      }
      const o = (y * size + x) * 3;
      rgb[o] = ROUND(R / area); rgb[o + 1] = ROUND(G / area); rgb[o + 2] = ROUND(B / area);
    }
  }
  const png = encodePng(rgb, size, size);
  const tEnd = Date.now();
  return {
    png, width: size, height: size, triangles: total, drawn, coverage: hit / N, upAxis: up, down: DOWN_NAMES[k],
    parts: used.map(u2 => sources.indexOf(u2)), assembly: used.length > 1 ? true : null,
    ms: { read: tRead - t0, raster: tRaster - tRead, shade: tShade - tRaster, encode: tEnd - tShade, total: tEnd - t0 },
  };
}

const BASE_NAME_RE = /(^|[^a-z])(base|bases|plinth|stand|pedestal)([^a-z]|$)/i;
function sourceName(src) {
  return path.basename(String(src.kind === 'zip' ? src.entry : (src.kind === 'buffer' ? src.name : src.path) || ''));
}

/**
 * Do these parts form one model in place? Not when their boxes mostly do not overlap: the union
 * box is more than 3x the summed part boxes, or fewer than half of the other parts touch the
 * largest part's box grown by 10%. The largest part is by surface area, base-like names last.
 * @returns {{ assembly: boolean, main: number }}
 */
function assemblyCheck(srcs, boxes, areas) {
  const n = srcs.length;
  let main = -1;
  for (let i = 0; i < n; i++) {
    const isBase = BASE_NAME_RE.test(sourceName(srcs[i]).replace(/\.[^.]+$/, ''));
    if (isBase) continue;
    if (main < 0 || areas[i] > areas[main]) main = i;
  }
  if (main < 0) { main = 0; for (let i = 1; i < n; i++) if (areas[i] > areas[main]) main = i; }
  const U = [POS_INF, POS_INF, POS_INF, NEG_INF, NEG_INF, NEG_INF];
  for (const b of boxes) for (let c = 0; c < 3; c++) { U[c] = MIN(U[c], b[c]); U[c + 3] = MAX(U[c + 3], b[c + 3]); }
  const pad = 0.01 * SQRT((U[3] - U[0]) ** 2 + (U[4] - U[1]) ** 2 + (U[5] - U[2]) ** 2); // flat parts still have a volume
  const vol = (b) => (b[3] - b[0] + pad) * (b[4] - b[1] + pad) * (b[5] - b[2] + pad);
  let sum = 0;
  for (const b of boxes) sum += vol(b);
  const spread = vol(U) > 3 * sum;
  const M = boxes[main];
  const g = [0, 1, 2].map(c => 0.1 * (M[c + 3] - M[c]) + pad);
  let touching = 0;
  for (let i = 0; i < n; i++) {
    if (i === main) continue;
    const b = boxes[i];
    let hit = true;
    for (let c = 0; c < 3; c++) if (b[c] > M[c + 3] + g[c] || b[c + 3] < M[c] - g[c]) hit = false;
    if (hit) touching++;
  }
  const apart = touching < (n - 1) / 2;
  return { assembly: !(spread || apart), main };
}

/** Summed-area table of a Float32Array (W x H) → Float64Array ((W+1) x (H+1)). */
function sat(src, W, H) {
  const S = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    const so = y * W, to = (y + 1) * (W + 1), po = y * (W + 1);
    for (let x = 0; x < W; x++) { row += src[so + x]; S[to + x + 1] = S[po + x + 1] + row; }
  }
  return S;
}
function boxSum(S, W, H, x, y, rad) {
  const x0 = MAX(0, x - rad), y0 = MAX(0, y - rad), x1 = MIN(W, x + rad + 1), y1 = MIN(H, y + rad + 1);
  const w1 = W + 1;
  return S[y1 * w1 + x1] - S[y0 * w1 + x1] - S[y1 * w1 + x0] + S[y0 * w1 + x0];
}

/** Lighting + occlusion + background → RGB at the supersampled size. */
function shade({ W, H, depth, nrm, scale, zmin, zmax }) {
  const N = W * H;
  const out = new Uint8Array(N * 3);
  const mask = new Float32Array(N);
  const dm = new Float32Array(N);
  for (let i = 0; i < N; i++) if (depth[i] > NEG_INF) { mask[i] = 1; dm[i] = depth[i]; }
  const Sm = sat(mask, W, H), Sd = sat(dm, W, H);
  const rSmall = MAX(4, ROUND(W * 0.012)), rLarge = MAX(10, ROUND(W * 0.05));
  const rShadow = MAX(8, ROUND(W * 0.03));
  const shadowDy = ROUND(W * 0.02);
  const zr = (zmax - zmin) || 1;
  const smoothTol = 2.5 / scale; // depth step allowed between neighbours for normal smoothing (≈2.5 px)

  // lights (view space, pointing toward the light)
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return v.map(c => c / l); };
  const K = norm([-0.45, 0.6, 0.66]), F = norm([0.75, 0.05, 0.45]), Hh = norm([K[0], K[1], K[2] + 1]);
  const base = [0.80, 0.78, 0.75]; // neutral clay

  for (let y = 0; y < H; y++) {
    // background: vertical grey gradient with a light vignette
    const t = y / (H - 1);
    const bgTop = 0.40, bgBot = 0.22;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const o = i * 3;
      if (!mask[i]) {
        const dx = (x - W / 2) / W, dy = (y - H * 0.45) / H;
        let g = (bgTop + (bgBot - bgTop) * t) * (1 - 0.35 * (dx * dx + dy * dy));
        // soft drop shadow: the silhouette blurred and moved down a little
        const sy = y - shadowDy;
        if (sy >= 0) {
          const cov = boxSum(Sm, W, H, x, sy, rShadow) / ((2 * rShadow + 1) * (2 * rShadow + 1));
          g *= 1 - 0.45 * cov;
        }
        const v = MAX(0, MIN(255, ROUND(g * 255)));
        out[o] = v; out[o + 1] = v; out[o + 2] = MIN(255, v + 3);
        continue;
      }
      const z = depth[i];
      // smoothed normal: 3x3 neighbours on the same surface (depth within tolerance)
      let nx = 0, ny = 0, nz = 0;
      for (let j = -1; j <= 1; j++) {
        const yy = y + j; if (yy < 0 || yy >= H) continue;
        for (let k = -1; k <= 1; k++) {
          const xx = x + k; if (xx < 0 || xx >= W) continue;
          const q = yy * W + xx;
          if (!mask[q] || ABS(depth[q] - z) > smoothTol) continue;
          const wgt = (j === 0 && k === 0) ? 2 : 1;
          nx += nrm[q * 3] * wgt; ny += nrm[q * 3 + 1] * wgt; nz += nrm[q * 3 + 2] * wgt;
        }
      }
      const nl = SQRT(nx * nx + ny * ny + nz * nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      // occlusion: how much nearer (toward the camera) the surroundings are, at two radii
      const cS = boxSum(Sm, W, H, x, y, rSmall), dS = boxSum(Sd, W, H, x, y, rSmall);
      const cL = boxSum(Sm, W, H, x, y, rLarge), dL = boxSum(Sd, W, H, x, y, rLarge);
      const aoS = MAX(0, (dS / cS - z) * scale) / rSmall;   // in radii
      const aoL = MAX(0, (dL / cL - z) * scale) / rLarge;
      const ao = (1 - 0.55 * MIN(1, aoS * 1.2)) * (1 - 0.35 * MIN(1, aoL * 1.5));
      const dn = (z - zmin) / zr; // 1 = nearest
      const depthShade = 0.78 + 0.22 * dn;
      const dk = MAX(0, nx * K[0] + ny * K[1] + nz * K[2]);
      const df = MAX(0, nx * F[0] + ny * F[1] + nz * F[2]);
      const amb = 0.24 * (0.7 + 0.3 * (ny * 0.5 + 0.5));
      const spec = POW(MAX(0, nx * Hh[0] + ny * Hh[1] + nz * Hh[2]), 28) * 0.16;
      const light = (0.78 * dk + 0.30 * df + amb) * ao * depthShade;
      for (let c = 0; c < 3; c++) {
        const v = base[c] * light + spec * ao;
        out[o + c] = MAX(0, MIN(255, ROUND(POW(MIN(1, v), 1 / 1.15) * 255)));
      }
    }
  }
  return out;
}

/** Rough triangle count from a file's size (binary STL is exact; others are estimates). */
function estimateTriangles(name, size) {
  const ext = path.extname(String(name)).toLowerCase();
  if (ext === '.stl') return MAX(0, ROUND((size - 84) / 50));
  if (ext === '.obj') return ROUND(size / 60);
  if (ext === '.3mf') return ROUND(size / 15); // compressed XML
  return 0;
}

module.exports = {
  assemblyCheck, DOWN_MATS, DOWN_NAMES, renderMeshes, forEachTriangle, encodePng, decodePng, estimateTriangles, viewBasis, MESH_EXTS,
};
