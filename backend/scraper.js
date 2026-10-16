const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');
const crypto = require('crypto');
const { URL } = require('url');

const IMAGES_DIR = process.env.IMAGES_DIR || '/data/images';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 20000;
const IMAGE_TIMEOUT_MS = 30000;

// ── SSRF guard ────────────────────────────────────────────────────────────────
// The scraper follows URLs that come from users, folder names and AI answers.
// It must never be usable to reach the NAS itself, the LAN, or cloud metadata.

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96],
]) blocked.addSubnet(addr, prefix, 'ipv6');

function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (!family) return true; // not an IP at all — refuse
  if (family === 6) {
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return blocked.check(mapped[1], 'ipv4');
    return blocked.check(ip, 'ipv6');
  }
  return blocked.check(ip, 'ipv4');
}

function privateAllowed() { return process.env.SCRAPER_ALLOW_PRIVATE === '1'; }

// Test hook: swap the "is this address forbidden?" check (default: isPrivateAddress).
let isForbidden = isPrivateAddress;
function _setAddressCheck(fn) { isForbidden = typeof fn === 'function' ? fn : isPrivateAddress; }

function blockedError(host, ip) {
  const e = new Error(`Refusing to fetch ${host}${ip && ip !== host ? ` (${ip})` : ''}: private, loopback or link-local address`);
  e.code = 'EBLOCKED';
  return e;
}

/** dns.lookup replacement used for every connection: checks EVERY resolved address. */
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const opts = typeof options === 'number' ? { family: options } : { ...(options || {}) };
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!privateAllowed()) {
      const bad = addresses.find(a => isForbidden(a.address));
      if (bad) return callback(blockedError(hostname, bad.address));
    }
    if (opts.all) return callback(null, addresses);
    const first = addresses[0];
    if (!first) return callback(new Error(`No address for ${hostname}`));
    callback(null, first.address, first.family);
  });
}

/** Validate a URL before connecting (protocol + literal IPs, which skip DNS lookup). */
async function assertFetchable(urlObj) {
  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${urlObj.protocol}`);
  }
  if (privateAllowed()) return;
  const host = urlObj.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isForbidden(host)) throw blockedError(host, host);
    return;
  }
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw blockedError(host);
  const addrs = await dns.promises.lookup(host, { all: true });
  const bad = addrs.find(a => isForbidden(a.address));
  if (bad) throw blockedError(host, bad.address);
}

/**
 * GET a URL with: redirect cap (relative Location resolved against the current
 * URL), SSRF checks on every hop, a body-size cap, and an overall deadline.
 * Resolves with the final response stream (not yet consumed) and its URL.
 */
async function openUrl(urlStr, { headers = {}, timeoutMs, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  let current = new URL(urlStr);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertFetchable(current);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Request timed out');
    const lib = current.protocol === 'https:' ? https : http;
    const signals = [AbortSignal.timeout(remaining)];
    if (signal) signals.push(signal);
    const res = await new Promise((resolve, reject) => {
      const req = lib.get(current, {
        headers: { 'User-Agent': UA, ...headers },
        lookup: safeLookup,
        signal: AbortSignal.any(signals),
      }, resolve);
      req.on('error', (e) => {
        if (e.name === 'AbortError') reject(signal?.aborted ? new Error('Request cancelled') : new Error('Request timed out'));
        else reject(e);
      });
    });
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume(); // discard body
      if (hop === MAX_REDIRECTS) throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
      current = new URL(res.headers.location, current);
      continue;
    }
    return { res, url: current.toString() };
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
}

async function fetchUrl(urlStr, options = {}) {
  const { res, url } = await openUrl(urlStr, {
    headers: { 'Accept': 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'en-US,en;q=0.9', ...options.headers },
    timeoutMs: options.timeoutMs || PAGE_TIMEOUT_MS,
    signal: options.signal,
  });
  const max = options.maxBytes || MAX_HTML_BYTES;
  const declared = parseInt(res.headers['content-length'], 10);
  if (Number.isFinite(declared) && declared > max) { res.destroy(); throw new Error(`Response too large (${declared} bytes)`); }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(e); } res.destroy(); };
    res.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > max) return fail(new Error(`Response too large (> ${max} bytes)`));
      chunks.push(chunk);
    });
    res.on('end', () => {
      if (settled) return;
      settled = true;
      resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers, url });
    });
    res.on('error', (e) => fail(e.name === 'AbortError' ? new Error('Request timed out') : e));
    res.on('aborted', () => fail(new Error('Connection aborted')));
  });
}

/**
 * Download an image to destPath. Writes to a temp file first and renames on
 * success, so a failed/redirected download never leaves (or deletes) a
 * half-written file. Requires an image/* content type and caps the size.
 */
async function downloadImage(imageUrl, destPath, { signal, timeoutMs = IMAGE_TIMEOUT_MS } = {}) {
  const referer = (() => { try { return new URL(imageUrl).origin; } catch { return undefined; } })();
  const { res } = await openUrl(imageUrl, { headers: referer ? { Referer: referer } : {}, timeoutMs, signal });
  if (res.statusCode !== 200) { res.resume(); throw new Error(`HTTP ${res.statusCode}`); }
  const type = String(res.headers['content-type'] || '').toLowerCase();
  if (!type.startsWith('image/')) { res.resume(); throw new Error(`Not an image (content-type: ${type || 'none'})`); }
  const declared = parseInt(res.headers['content-length'], 10);
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) { res.destroy(); throw new Error(`Image too large (${declared} bytes)`); }

  const tmp = `${destPath}.part-${crypto.randomBytes(4).toString('hex')}`;
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tmp, { flags: 'wx' });
    let size = 0;
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      res.destroy();
      file.destroy();
      fs.unlink(tmp, () => reject(err));
    };
    res.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) fail(new Error(`Image too large (> ${MAX_IMAGE_BYTES} bytes)`));
    });
    res.on('error', (e) => fail(e.name === 'AbortError' ? new Error('Timeout') : e));
    res.on('aborted', () => fail(new Error('Connection aborted')));
    file.on('error', fail);
    file.on('finish', () => {
      if (failed) return;
      fs.rename(tmp, destPath, (err) => {
        if (err) { fs.unlink(tmp, () => {}); return reject(err); }
        resolve();
      });
    });
    res.pipe(file);
  });
  return destPath;
}

// ── Site-specific scrapers ────────────────────────────────────────────────────

function scrapeOpenGraph(html) {
  const images = [];
  const ogPattern = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/gi;
  const ogPattern2 = /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/gi;
  let m;
  while ((m = ogPattern.exec(html)) !== null) images.push(m[1]);
  while ((m = ogPattern2.exec(html)) !== null) images.push(m[1]);
  return [...new Set(images)];
}

/**
 * POST a GraphQL query to the Printables public API.
 * Returns { body, status } like fetchUrl but uses POST.
 */
function printablesGraphQL(query, variables) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ query, variables });
    const req = https.request({
      hostname: 'api.printables.com',
      path: '/graphql/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'Mozilla/5.0 (compatible; VaultScraper/1.0)',
        'Accept': 'application/json',
      },
      timeout: 12000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (data.length > MAX_HTML_BYTES) { req.destroy(); reject(new Error('GraphQL response too large')); }
      });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('GraphQL request timed out')); });
    req.write(payload);
    req.end();
  });
}

async function scrapePrintables(url, modelUuid) {
  // Printables model URLs: printables.com/model/123456-name
  const match = url.match(/printables\.com\/model\/(\d+)/i);
  if (!match) throw new Error('Not a valid Printables model URL');
  const modelId = match[1];

  // ── Try official GraphQL API first ────────────────────────────────────────
  try {
    const gqlQuery = `
      query PrintDetail($id: ID!) {
        print(id: $id) {
          id
          name
          summary
          description
          images { filePath }
          tags { name }
        }
      }
    `;
    const { status, body } = await printablesGraphQL(gqlQuery, { id: modelId });
    if (status === 200) {
      const json = JSON.parse(body);
      const print = json?.data?.print;
      if (print) {
        const images = (print.images || [])
          .map(img => {
            const fp = img.filePath || '';
            // filePath is like "/media/prints/12345/abc.jpg" — prepend CDN base
            return fp.startsWith('http') ? fp : `https://media.printables.com${fp}`;
          })
          .filter(u => /\.(jpg|jpeg|png|webp)/i.test(u))
          .slice(0, 8);
        return { images, sourceSite: 'printables', sourceUrl: url };
      }
    }
  } catch (apiErr) {
    // fall through to HTML scraping
  }

  // ── Fallback: HTML scraping ───────────────────────────────────────────────
  const { body } = await fetchUrl(url);
  const images = [];

  // JSON-LD structured data
  const jsonLdMatch = body.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatch) {
    for (const block of jsonLdMatch) {
      try {
        const inner = block.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
        const data = JSON.parse(inner);
        const imgs = data.image || data.thumbnail || [];
        if (Array.isArray(imgs)) images.push(...imgs);
        else if (typeof imgs === 'string') images.push(imgs);
      } catch {}
    }
  }

  images.push(...scrapeOpenGraph(body));

  // Printables CDN pattern
  const imgPattern = /["'](https:\/\/media\.printables\.com\/media\/[^"']+\.(jpg|jpeg|png|webp))["']/gi;
  let m;
  while ((m = imgPattern.exec(body)) !== null) images.push(m[1]);

  const unique = [...new Set(images)].filter(u => u.startsWith('http')).slice(0, 8);
  return { images: unique, sourceSite: 'printables', sourceUrl: url };
}

async function scrapeMyMiniFactory(url, modelUuid) {
  const { body } = await fetchUrl(url);
  const images = [];

  // MMF uses og:image and also has image arrays in page scripts
  const ogImgs = scrapeOpenGraph(body);
  images.push(...ogImgs);

  // MMF image pattern
  const imgPattern = /["'](https:\/\/cdn\.myminifactory\.com\/assets\/object-assets\/[^"']+\.(jpg|jpeg|png|webp))["']/gi;
  let m;
  while ((m = imgPattern.exec(body)) !== null) images.push(m[1]);

  const unique = [...new Set(images)].filter(u => u.startsWith('http')).slice(0, 8);
  return { images: unique, sourceSite: 'myminifactory', sourceUrl: url };
}

async function scrapeThingiverse(url, modelUuid) {
  // Thingiverse: thingiverse.com/thing:123456
  const match = url.match(/thing:(\d+)/i);
  if (!match) throw new Error('Not a valid Thingiverse thing URL');

  const thingId = match[1];
  const { body } = await fetchUrl(url);
  const images = [];

  const ogImgs = scrapeOpenGraph(body);
  images.push(...ogImgs);

  // Thingiverse CDN pattern
  const imgPattern = /["'](https:\/\/cdn\.thingiverse\.com\/assets\/[^"']+\.(jpg|jpeg|png|webp))["']/gi;
  let m;
  while ((m = imgPattern.exec(body)) !== null) images.push(m[1]);

  const unique = [...new Set(images)].filter(u => u.startsWith('http')).slice(0, 8);
  return { images: unique, sourceSite: 'thingiverse', sourceUrl: url };
}

async function scrapeCults3d(url) {
  const { body } = await fetchUrl(url);
  const images = scrapeOpenGraph(body);

  const imgPattern = /["'](https:\/\/files\.cults3d\.com\/[^"']+\.(jpg|jpeg|png|webp))["']/gi;
  let m;
  while ((m = imgPattern.exec(body)) !== null) images.push(m[1]);

  const unique = [...new Set(images)].filter(u => u.startsWith('http')).slice(0, 8);
  return { images: unique, sourceSite: 'cults3d', sourceUrl: url };
}

async function scrapeGumroad(url) {
  const { body } = await fetchUrl(url);
  const images = scrapeOpenGraph(body);
  const unique = [...new Set(images)].filter(u => u.startsWith('http')).slice(0, 8);
  return { images: unique, sourceSite: 'gumroad', sourceUrl: url };
}

function detectSiteFromUrl(url) {
  const lower = url.toLowerCase();
  if (lower.includes('printables.com')) return 'printables';
  if (lower.includes('myminifactory.com')) return 'myminifactory';
  if (lower.includes('thingiverse.com')) return 'thingiverse';
  if (lower.includes('cults3d.com')) return 'cults3d';
  if (lower.includes('gumroad.com')) return 'gumroad';
  if (lower.includes('patreon.com')) return 'patreon';
  return null;
}

// ── Folder name auto-detection ────────────────────────────────────────────────

const FOLDER_PATTERNS = [
  // Printables: "[PR-123456] Model Name" or "printables_123456" or "123456 - Model Name"
  { site: 'printables', pattern: /(?:PR[-_\s]?|printables[-_\s]?)(\d{4,})/i, urlTemplate: 'https://www.printables.com/model/{id}' },
  // Thingiverse: "[TV-123456]" or "thingiverse_123456" or "thing_123456"
  { site: 'thingiverse', pattern: /(?:TV[-_\s]?|thingiverse[-_\s]?|thing[-_\s]?)(\d{4,})/i, urlTemplate: 'https://www.thingiverse.com/thing:{id}' },
  // MMF: "[MMF-123456]" or "mmf_123456"
  { site: 'myminifactory', pattern: /(?:MMF[-_\s]?)(\d{4,})/i, urlTemplate: 'https://www.myminifactory.com/object/{id}' },
];

function detectUrlFromFolderName(folderName) {
  for (const { site, pattern, urlTemplate } of FOLDER_PATTERNS) {
    const m = folderName.match(pattern);
    if (m) {
      return { site, url: urlTemplate.replace('{id}', m[1]), id: m[1] };
    }
  }
  return null;
}

// ── Main scrape function ──────────────────────────────────────────────────────

async function scrapeImagesFromUrl(sourceUrl, modelUuid, logger, { signal } = {}) {
  const log = logger || (() => {});
  if (!/^[0-9a-f-]{8,64}$/i.test(String(modelUuid || ''))) throw new Error('Invalid model id');
  try { await assertFetchable(new URL(sourceUrl)); } catch (e) { throw new Error(e.code === 'ERR_INVALID_URL' ? 'Invalid URL' : e.message); }
  const site = detectSiteFromUrl(sourceUrl);
  let result;

  log('info', `Detected site: ${site || 'unknown'}`);

  switch (site) {
    case 'printables':    result = await scrapePrintables(sourceUrl, modelUuid); break;
    case 'myminifactory': result = await scrapeMyMiniFactory(sourceUrl, modelUuid); break;
    case 'thingiverse':   result = await scrapeThingiverse(sourceUrl, modelUuid); break;
    case 'cults3d':       result = await scrapeCults3d(sourceUrl); break;
    case 'gumroad':       result = await scrapeGumroad(sourceUrl); break;
    default:
      log('info', 'Using generic og:image fallback');
      const { body } = await fetchUrl(sourceUrl, { signal });
      const imgs = scrapeOpenGraph(body);
      result = { images: imgs.slice(0, 8), sourceSite: 'unknown', sourceUrl };
  }

  log('info', `Found ${result.images.length} image URL(s) on page`);

  if (!result.images || result.images.length === 0) {
    throw new Error('No images found at that URL. Try a different URL or upload images manually.');
  }

  const modelImgDir = path.join(IMAGES_DIR, modelUuid);
  if (!fs.existsSync(modelImgDir)) fs.mkdirSync(modelImgDir, { recursive: true });

  const savedPaths = [];
  for (let i = 0; i < result.images.length; i++) {
    if (signal?.aborted) break;
    try {
      const imgUrl = new URL(result.images[i], result.sourceUrl || sourceUrl).toString();
      log('img', `  Downloading image ${i + 1}/${result.images.length}...`);
      const ext = ((imgUrl.match(/\.(jpg|jpeg|png|webp)/i) || ['', '.jpg'])[0] || '.jpg').toLowerCase();
      const filename = `scraped_${i + 1}${ext}`;
      const destPath = path.join(modelImgDir, filename);
      await downloadImage(imgUrl, destPath, { signal });
      savedPaths.push(`/images/${modelUuid}/${filename}`);
      log('success', `    ✓ Saved ${filename}`);
    } catch (e) {
      log('warn', `    ✗ Failed to download image ${i + 1}: ${e.message}`);
    }
  }

  return { savedPaths, sourceSite: result.sourceSite, sourceUrl: result.sourceUrl };
}

module.exports = {
  scrapeImagesFromUrl, detectUrlFromFolderName, detectSiteFromUrl,
  // exported for tests
  fetchUrl, downloadImage, isPrivateAddress, _setAddressCheck, MAX_REDIRECTS, MAX_HTML_BYTES, MAX_IMAGE_BYTES,
};
