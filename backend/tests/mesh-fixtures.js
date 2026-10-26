'use strict';
/** Small real meshes and images for the thumbnail tests (generated, never read from a library). */
const zlib = require('zlib');

/** Triangles of an axis-aligned box: [[ax,ay,az,bx,by,bz,cx,cy,cz], ...] (outward winding). */
function boxTris(x0, y0, z0, x1, y1, z1) {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return faces.map(f => [...v[f[0]], ...v[f[1]], ...v[f[2]]]);
}

/** A bumpy torus with about nu*nv*2 triangles (Z up, sitting on z=0). */
function torusTris(nu, nv, R = 30, r = 10) {
  const P = (i, j) => {
    const u = (i / nu) * 2 * Math.PI, w = (j / nv) * 2 * Math.PI;
    return [(R + r * Math.cos(w)) * Math.cos(u), (R + r * Math.cos(w)) * Math.sin(u), r + r * Math.sin(w) + 4 * Math.sin(3 * u) + 4];
  };
  const out = [];
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
    out.push([...a, ...b, ...c], [...a, ...c, ...d]);
  }
  return out;
}

function binaryStl(tris) {
  const buf = Buffer.alloc(84 + 50 * tris.length);
  buf.write('binary stl from the vault tests', 0, 'latin1');
  buf.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const t of tris) {
    o += 12; // normal left at 0: the renderer computes its own
    for (const c of t) { buf.writeFloatLE(c, o); o += 4; }
    o += 2;
  }
  return buf;
}

/** Binary STL written straight to a file in chunks (big meshes without one huge array). */
function writeTorusStl(fs, file, nu, nv) {
  const n = nu * nv * 2;
  const fd = fs.openSync(file, 'w');
  const head = Buffer.alloc(84); head.writeUInt32LE(n, 80);
  fs.writeSync(fd, head);
  const P = (i, j) => {
    const u = (i / nu) * 2 * Math.PI, w = (j / nv) * 2 * Math.PI;
    return [(30 + 10 * Math.cos(w)) * Math.cos(u), (30 + 10 * Math.cos(w)) * Math.sin(u), 10 + 10 * Math.sin(w) + 4 * Math.sin(3 * u)];
  };
  for (let i = 0; i < nu; i++) {
    const buf = Buffer.alloc(50 * nv * 2);
    let o = 0;
    for (let j = 0; j < nv; j++) {
      const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
      for (const t of [[a, b, c], [a, c, d]]) { o += 12; for (const p of t) for (const x of p) { buf.writeFloatLE(x, o); o += 4; } o += 2; }
    }
    fs.writeSync(fd, buf);
  }
  fs.closeSync(fd);
  return n;
}

function asciiStl(tris, name = 'part') {
  const lines = [`solid ${name}`];
  for (const t of tris) {
    lines.push('  facet normal 0 0 0', '    outer loop');
    for (let k = 0; k < 9; k += 3) lines.push(`      vertex ${t[k]} ${t[k + 1]} ${t[k + 2]}`);
    lines.push('    endloop', '  endfacet');
  }
  lines.push(`endsolid ${name}`);
  return lines.join('\n') + '\n';
}

function obj(tris) {
  const v = [], f = [];
  tris.forEach((t, i) => {
    for (let k = 0; k < 9; k += 3) v.push(`v ${t[k]} ${t[k + 1]} ${t[k + 2]}`);
    f.push(`f ${i * 3 + 1}/1/1 ${i * 3 + 2}/2/2 ${i * 3 + 3}/3/3`);
  });
  return `# test\n${v.join('\n')}\nvt 0 0\nvt 1 0\nvt 0 1\n${f.join('\n')}\n`;
}

/** 3MF (zip) with one mesh object placed by a build item transform. */
function threeMf(tris, AdmZip, { translate = [0, 0, 0] } = {}) {
  const verts = [], idx = [];
  tris.forEach((t, i) => { for (let k = 0; k < 9; k += 3) verts.push(`<vertex x="${t[k]}" y="${t[k + 1]}" z="${t[k + 2]}"/>`); idx.push(`<triangle v1="${i * 3}" v2="${i * 3 + 1}" v3="${i * 3 + 2}"/>`); });
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  <object id="1" type="model"><mesh><vertices>${verts.join('')}</vertices><triangles>${idx.join('')}</triangles></mesh></object>
 </resources>
 <build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 ${translate.join(' ')}"/></build>
</model>`;
  const z = new AdmZip();
  z.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  z.addFile('3D/3dmodel.model', Buffer.from(model));
  return z.toBuffer();
}

/** A noisy PNG (does not compress, so it passes the 20 KB peek floor). */
async function noisyImage(sharp, w, h, fmt = 'png') {
  const raw = Buffer.alloc(w * h * 3);
  let x = (w * 73856093) ^ (h * 19349663) ^ 0x9e3779b9;
  for (let i = 0; i < raw.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; raw[i] = (x >>> 8) & 255; } // xorshift32
  const img = sharp(raw, { raw: { width: w, height: h, channels: 3 } });
  return fmt === 'jpeg' ? img.jpeg({ quality: 95 }).toBuffer() : img.png().toBuffer();
}

module.exports = { boxTris, torusTris, binaryStl, writeTorusStl, asciiStl, obj, threeMf, noisyImage, zlib };
