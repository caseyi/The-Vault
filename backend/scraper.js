const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const IMAGES_DIR = process.env.IMAGES_DIR || '/data/images';

function fetchUrl(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(urlStr, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...options.headers
      },
      timeout: 15000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, options).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function downloadImage(imageUrl, destPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(imageUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const file = fs.createWriteStream(destPath);
    const req = lib.get(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Referer': url.origin
      },
      timeout: 20000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(destPath, () => {});
        return downloadImage(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => {});
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(destPath)));
    });
    req.on('error', (err) => { file.close(); fs.unlink(destPath, () => {}); reject(err); });
    req.on('timeout', () => { req.destroy(); file.close(); fs.unlink(destPath, () => {}); reject(new Error('Timeout')); });
  });
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

async function scrapePrintables(url, modelUuid) {
  // Printables model URLs: printables.com/model/123456-name
  const match = url.match(/printables\.com\/model\/(\d+)/i);
  if (!match) throw new Error('Not a valid Printables model URL');

  const modelId = match[1];
  // Try the API endpoint first
  const apiUrl = `https://api.printables.com/graphql/`;
  // Fall back to HTML scraping
  const { body } = await fetchUrl(url);

  // Extract images from JSON-LD or og:image
  const images = [];

  // Try JSON-LD structured data
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

  // Try og:image
  const ogImgs = scrapeOpenGraph(body);
  images.push(...ogImgs);

  // Try to find image URLs in the page source (Printables uses specific patterns)
  const imgPattern = /["'](https:\/\/media\.printables\.com\/media\/[^"']+\.(jpg|jpeg|png|webp))["']/gi;
  let m;
  while ((m = imgPattern.exec(body)) !== null) {
    images.push(m[1]);
  }

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

async function scrapeImagesFromUrl(sourceUrl, modelUuid, logger) {
  const log = logger || (() => {});
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
      const { body } = await fetchUrl(sourceUrl);
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
    try {
      const imgUrl = result.images[i];
      log('img', `  Downloading image ${i + 1}/${result.images.length}...`);
      const ext = (imgUrl.match(/\.(jpg|jpeg|png|webp)/i) || ['', '.jpg'])[0] || '.jpg';
      const filename = `scraped_${i + 1}${ext}`;
      const destPath = path.join(modelImgDir, filename);
      await downloadImage(imgUrl, destPath);
      savedPaths.push(`/images/${modelUuid}/${filename}`);
      log('success', `    ✓ Saved ${filename}`);
    } catch (e) {
      log('warn', `    ✗ Failed to download image ${i + 1}: ${e.message}`);
    }
  }

  return { savedPaths, sourceSite: result.sourceSite, sourceUrl: result.sourceUrl };
}

module.exports = { scrapeImagesFromUrl, detectUrlFromFolderName, detectSiteFromUrl };
