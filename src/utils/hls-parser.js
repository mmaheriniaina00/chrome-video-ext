/**
 * HLS (M3U8) parser — master playlists, media playlists, AES-128 key
 * extraction, and segment-level detail.
 */

/**
 * @typedef {Object} HlsVariant
 * @property {string}      url        — absolute URL of the variant playlist
 * @property {number}      bandwidth  — bits per second
 * @property {number|null} width
 * @property {number|null} height
 * @property {string}      codecs
 * @property {string}      label      — human-readable quality string
 */

/**
 * @typedef {Object} HlsSegment
 * @property {string}      url       — absolute segment URL
 * @property {number}      duration  — seconds
 * @property {number}      sequence  — media sequence number
 * @property {HlsKeyInfo|null} key   — encryption info (null = unencrypted)
 */

/**
 * @typedef {Object} HlsKeyInfo
 * @property {string} method   — "AES-128" | "SAMPLE-AES" | "NONE"
 * @property {string} uri      — absolute URL of the key
 * @property {string|null} iv  — hex IV string or null (derive from sequence)
 */

/**
 * @typedef {Object} HlsMediaPlaylist
 * @property {HlsSegment[]} segments
 * @property {number}       targetDuration
 * @property {number}       totalDuration
 * @property {boolean}      encrypted     — true if any segment uses AES-128
 * @property {boolean}      hasDrm        — true if SAMPLE-AES or similar is detected
 */

// ── Master playlist ─────────────────────────────────────────────────

/**
 * Parse a master playlist and return variant descriptors.
 *
 * @param {string} body      — raw M3U8 text
 * @param {string} baseUrl   — base URL used to resolve relative URIs
 * @returns {HlsVariant[]}
 */
export function parseMasterPlaylist(body, baseUrl) {
  const lines = body.split(/\r?\n/);
  const variants = [];
  let pendingAttrs = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('#EXT-X-STREAM-INF:')) {
      pendingAttrs = parseAttributes(trimmed.substring('#EXT-X-STREAM-INF:'.length));
      continue;
    }

    if (pendingAttrs && trimmed && !trimmed.startsWith('#')) {
      const url = resolveUrl(trimmed, baseUrl);
      const bandwidth = parseInt(pendingAttrs.BANDWIDTH, 10) || 0;
      const codecs = pendingAttrs.CODECS || '';
      const resolution = pendingAttrs.RESOLUTION || '';
      let width = null;
      let height = null;
      if (resolution) {
        const [w, h] = resolution.split('x').map(Number);
        width = w || null;
        height = h || null;
      }
      const label = height ? `${height}p` : `${Math.round(bandwidth / 1000)}k`;
      variants.push({ url, bandwidth, width, height, codecs, label });
      pendingAttrs = null;
    }
  }

  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return variants;
}

// ── Media playlist (with AES-128 support) ───────────────────────────

/**
 * Parse a media playlist into detailed segments with encryption info.
 *
 * @param {string} body
 * @param {string} baseUrl
 * @returns {HlsMediaPlaylist}
 */
export function parseMediaPlaylistDetailed(body, baseUrl) {
  const lines = body.split(/\r?\n/);
  const segments = [];

  let mediaSequence = 0;
  let targetDuration = 0;
  let totalDuration = 0;
  let currentKey = null;
  let encrypted = false;
  let hasDrm = false;
  let segDuration = 0;
  let seqCounter = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(trimmed.split(':')[1], 10) || 0;
      seqCounter = mediaSequence;
      continue;
    }

    if (trimmed.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseInt(trimmed.split(':')[1], 10) || 0;
      continue;
    }

    if (trimmed.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(trimmed.substring('#EXT-X-KEY:'.length));
      const method = attrs.METHOD || 'NONE';

      if (method === 'NONE') {
        currentKey = null;
      } else if (method === 'AES-128') {
        encrypted = true;
        const keyUri = attrs.URI ? resolveUrl(attrs.URI, baseUrl) : '';
        const iv = attrs.IV || null;
        currentKey = { method, uri: keyUri, iv };
      } else {
        // SAMPLE-AES or unknown → DRM
        hasDrm = true;
        currentKey = { method, uri: '', iv: null };
      }
      continue;
    }

    if (trimmed.startsWith('#EXTINF:')) {
      segDuration = parseFloat(trimmed.split(':')[1]) || 0;
      continue;
    }

    // Non-comment, non-empty line = segment URL
    if (trimmed && !trimmed.startsWith('#')) {
      const url = resolveUrl(trimmed, baseUrl);
      segments.push({
        url,
        duration: segDuration,
        sequence: seqCounter,
        key: currentKey ? { ...currentKey } : null,
      });
      totalDuration += segDuration;
      seqCounter++;
      segDuration = 0;
    }
  }

  return { segments, targetDuration, totalDuration, encrypted, hasDrm };
}

/**
 * Simple segment-URL-only parse (backward compat).
 *
 * @param {string} body
 * @param {string} baseUrl
 * @returns {string[]}
 */
export function parseMediaPlaylist(body, baseUrl) {
  return body
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => resolveUrl(l, baseUrl));
}

// ── Detection helpers ───────────────────────────────────────────────

/** Detect whether the text looks like an HLS playlist. */
export function isHlsPlaylist(text) {
  return typeof text === 'string' && text.trimStart().startsWith('#EXTM3U');
}

/** Detect whether the playlist is a master (multi-variant) playlist. */
export function isMasterPlaylist(text) {
  return isHlsPlaylist(text) && text.includes('#EXT-X-STREAM-INF');
}

/** Detect whether the playlist uses AES-128 encryption. */
export function isAesEncrypted(text) {
  return typeof text === 'string' && /EXT-X-KEY.*METHOD=AES-128/i.test(text);
}

/** Detect whether the playlist uses SAMPLE-AES or other DRM. */
export function hasDrmEncryption(text) {
  return typeof text === 'string' && /EXT-X-KEY.*METHOD=SAMPLE-AES/i.test(text);
}

// ── Internal helpers ────────────────────────────────────────────────

function parseAttributes(raw) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(raw))) {
    attrs[m[1]] = m[2] ?? m[3];
  }
  return attrs;
}

function resolveUrl(relative, base) {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}
