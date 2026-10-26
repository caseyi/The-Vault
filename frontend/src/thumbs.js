// Picking image URLs for cards and the detail viewer.
// Newer backends send small cached copies (`thumb_url`, `thumb_urls`, served
// from /thumbs/...?w=480|1280); older ones only send `images` and
// `thumbnail_path`, which are the full-size originals.

const isThumbUrl = (u) => typeof u === 'string' && u.startsWith('/thumbs/');

/** Swap the `w=` size of a /thumbs/ URL (other URLs are returned unchanged). */
export function withThumbWidth(url, w) {
  if (!isThumbUrl(url)) return url;
  if (/[?&]w=\d+/.test(url)) return url.replace(/([?&])w=\d+/, `$1w=${w}`);
  return `${url}${url.includes('?') ? '&' : '?'}w=${w}`;
}

/**
 * Images to show on a gallery card, best first. Prefers thumb_urls, then
 * thumb_url, then the originals for older backends.
 */
export function cardImages(model) {
  if (!model) return [];
  const thumbs = Array.isArray(model.thumb_urls) ? model.thumb_urls.filter(Boolean) : [];
  if (thumbs.length) {
    if (model.thumb_url && !thumbs.includes(model.thumb_url)) return [model.thumb_url, ...thumbs].slice(0, 4);
    return thumbs;
  }
  if (model.thumb_url) return [model.thumb_url];
  // Older backend: same order as before (images, else the thumbnail alone).
  const imgs = Array.isArray(model.images) ? model.images.filter(Boolean) : [];
  if (imgs.length) return imgs;
  return model.thumbnail_path ? [model.thumbnail_path] : [];
}

/** True when the card picture was rendered from the 3D mesh. */
export const isMeshPreview = (model) => !!model && model.thumb_source === 'stl';

/**
 * Detail viewer image for index i at a given size: the w=1280 thumb (or its
 * w=480 variant for the filmstrip) when the backend sent one, else the original.
 */
export function detailImage(model, i, w = 1280) {
  const images = (model && model.images) || [];
  const thumbs = (model && Array.isArray(model.thumb_urls)) ? model.thumb_urls : [];
  const t = thumbs[i];
  if (t) return withThumbWidth(t, w);
  return images[i];
}

/** Human-readable byte size (cache size in the Scan window). */
export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let u = 0;
  while (x >= 1024 && u < units.length - 1) { x /= 1024; u++; }
  return `${x < 10 ? x.toFixed(1) : Math.round(x)} ${units[u]}`;
}
