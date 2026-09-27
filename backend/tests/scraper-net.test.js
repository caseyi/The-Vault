/**
 * B9: scraper network hardening against a local HTTP server.
 * 127.0.0.1 is itself a "private" address, so the positive tests opt in with
 * SCRAPER_ALLOW_PRIVATE=1 and the SSRF tests run without it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scrape-'));
process.env.IMAGES_DIR = path.join(TMP, 'images');

const { fetchUrl, downloadImage, isPrivateAddress, scrapeImagesFromUrl, MAX_HTML_BYTES, _setAddressCheck } = require('../scraper');

let server, base;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const n = parseInt(u.searchParams.get('n') || '0', 10);
    switch (u.pathname) {
      case '/page': res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<meta property="og:image" content="/img.png">');
      case '/rel': res.writeHead(302, { location: '../page' }); return res.end();
      case '/loop': res.writeHead(302, { location: `/loop?n=${n + 1}` }); return res.end();
      case '/redir5': res.writeHead(302, { location: n < 4 ? `/redir5?n=${n + 1}` : '/page' }); return res.end();
      case '/huge': {
        res.writeHead(200, { 'content-type': 'text/html' });
        const chunk = Buffer.alloc(1024 * 1024, 'a');
        let sent = 0;
        const pump = () => { while (sent < 8 && res.write(chunk)) sent++; if (sent < 8) res.once('drain', pump); else res.end(); };
        return pump();
      }
      case '/img.png': res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from('PNGDATA'));
      case '/img-redirect.png': res.writeHead(301, { location: '/img.png' }); return res.end();
      case '/notimage.png': res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>');
      case '/slow': { const t = setTimeout(() => { try { res.end('late'); } catch {} }, 3000); t.unref(); return; }
      case '/metadata': res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); return res.end();
      default: res.writeHead(404); return res.end();
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
  delete process.env.SCRAPER_ALLOW_PRIVATE;
  fs.rmSync(TMP, { recursive: true, force: true });
});
afterEach(() => { delete process.env.SCRAPER_ALLOW_PRIVATE; });

describe('SSRF guard', () => {
  test('isPrivateAddress', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.140', '172.16.0.1', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '100.64.0.1']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '172.32.0.1']) expect(isPrivateAddress(ip)).toBe(false);
  });

  test('loopback / LAN / localhost URLs are refused by default', async () => {
    await expect(fetchUrl(`${base}/page`)).rejects.toThrow(/private, loopback or link-local/);
    await expect(fetchUrl('http://localhost:1/')).rejects.toThrow(/Refusing/);
    await expect(downloadImage(`${base}/img.png`, path.join(TMP, 'x.png'))).rejects.toThrow(/Refusing/);
    await expect(scrapeImagesFromUrl('http://192.168.1.1/admin', 'abcdef12-0000-0000-0000-000000000000')).rejects.toThrow(/Refusing/);
    await expect(fetchUrl('file:///etc/passwd')).rejects.toThrow(/Unsupported URL protocol/);
  });
});

describe('fetchUrl / downloadImage (SCRAPER_ALLOW_PRIVATE=1)', () => {
  beforeEach(() => { process.env.SCRAPER_ALLOW_PRIVATE = '1'; });

  test('relative redirects resolve against the current URL', async () => {
    const r2 = await fetchUrl(`${base}/rel`);
    expect(r2.body).toMatch(/og:image/);
    expect(r2.url).toBe(`${base}/page`);
  });

  test('up to 5 redirects are followed; the 6th fails', async () => {
    expect((await fetchUrl(`${base}/redir5`)).body).toMatch(/og:image/);
    await expect(fetchUrl(`${base}/loop`)).rejects.toThrow(/Too many redirects/);
  });

  test('HTML bodies are capped', async () => {
    expect(MAX_HTML_BYTES).toBe(5 * 1024 * 1024);
    await expect(fetchUrl(`${base}/huge`)).rejects.toThrow(/too large/);
  });

  test('overall timeout', async () => {
    await expect(fetchUrl(`${base}/slow`, { timeoutMs: 300 })).rejects.toThrow(/timed out/);
  });

  test('images: content-type enforced, temp file + rename, redirects safe', async () => {
    const dest = path.join(TMP, 'img.png');
    await downloadImage(`${base}/img-redirect.png`, dest);
    expect(fs.readFileSync(dest, 'utf8')).toBe('PNGDATA');
    expect(fs.readdirSync(TMP).some(n => n.includes('.part-'))).toBe(false);

    const bad = path.join(TMP, 'bad.png');
    await expect(downloadImage(`${base}/notimage.png`, bad)).rejects.toThrow(/Not an image/);
    expect(fs.existsSync(bad)).toBe(false);
  });

  test('every redirect hop is re-checked (allowed host → cloud metadata is blocked)', async () => {
    delete process.env.SCRAPER_ALLOW_PRIVATE;
    _setAddressCheck((ip) => ip.startsWith('169.254.')); // let 127.0.0.1 through, block link-local
    try {
      expect((await fetchUrl(`${base}/page`)).status).toBe(200);
      await expect(fetchUrl(`${base}/metadata`)).rejects.toThrow(/Refusing to fetch 169\.254\.169\.254/);
    } finally { _setAddressCheck(null); }
  });
});
