/**
 * Video format utilities — MIME type mapping, quality labels, and size estimation.
 */

export const MIME_TO_EXT = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/x-flv': 'flv',
  'application/vnd.apple.mpegurl': 'm3u8',
  'application/x-mpegURL': 'm3u8',
  'application/dash+xml': 'mpd',
};

export const VIDEO_EXTENSIONS = new Set([
  'mp4', 'webm', 'ogv', 'mkv', 'mov', 'avi', 'flv', 'm3u8', 'mpd', 'ts',
]);

/** Guess extension from a URL path. */
export function extFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split('.').pop()?.toLowerCase();
    if (ext && VIDEO_EXTENSIONS.has(ext)) return ext;
  } catch { /* ignore */ }
  return null;
}

/** Guess extension from a MIME type. */
export function extFromMime(mime) {
  if (!mime) return null;
  const base = mime.split(';')[0].trim().toLowerCase();
  return MIME_TO_EXT[base] ?? null;
}

/** Human-readable file size. */
export function formatBytes(bytes) {
  if (bytes == null || bytes <= 0) return 'Unknown size';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Build a quality label from width/height. */
export function qualityLabel(width, height) {
  if (!height) return '';
  if (height >= 2160) return '4K';
  if (height >= 1440) return '1440p';
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  if (height >= 480) return '480p';
  if (height >= 360) return '360p';
  if (height >= 240) return '240p';
  return `${height}p`;
}

/** Derive a filename from a URL, with fallback. */
export function filenameFromUrl(url, fallbackExt = 'mp4') {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split('/').filter(Boolean);
    const last = segments.pop() || '';
    if (last && /\.\w{2,5}$/.test(last)) return decodeURIComponent(last);
  } catch { /* ignore */ }
  return `video_${Date.now()}.${fallbackExt}`;
}

/**
 * Clean a page title: split on separators, drop duplicate segments,
 * segments contained in a longer one, and the site name.
 * @param {string} title
 * @param {string} [pageUrl] used to detect the site-name segment
 * @returns {string}
 */
export function cleanTitle(title, pageUrl = '') {
  if (!title) return '';
  const norm = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  let segments = title.split(/\s+[-–—|·•:]+\s+|\s*\|\s*/).map(s => s.trim()).filter(Boolean);
  if (segments.length < 2) return title.trim();

  // Drop site-name segment (e.g. "Voiranime" for v6.voiranime.com).
  let host = '';
  try { host = norm(new URL(pageUrl).hostname.replace(/^www\./, '')).replace(/ /g, ''); } catch { /* ignore */ }
  if (host) {
    const rest = segments.filter(s => {
      const n = norm(s).replace(/ /g, '');
      return !(n && host.includes(n));
    });
    if (rest.length) segments = rest;
  }

  // Drop duplicates and segments fully contained in another one.
  const norms = segments.map(norm);
  const kept = segments.filter((_, i) => {
    const n = norms[i];
    if (!n) return false;
    return !norms.some((m, j) => {
      if (j === i) return false;
      if (m === n) return j < i;                         // keep first of equals
      return ` ${m} `.includes(` ${n} `);                // contained in longer
    });
  });

  return (kept.length ? kept : segments).join(' - ');
}
