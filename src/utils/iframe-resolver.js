/**
 * Iframe Resolver — detects video-embedding iframes, extracts auth tokens,
 * and resolves stream manifest URLs from embed pages.
 */

// ── Known video embed patterns ──────────────────────────────────────

/**
 * Configurable allow-list of known video platform domains.
 * Each entry is a regex tested against the iframe src hostname.
 */
const KNOWN_VIDEO_DOMAINS = [
  /^www\.youtube\.com$/i,
  /^www\.youtube-nocookie\.com$/i,
  /medius\.microsoft\.com$/i,
  /microsoftstream\.com$/i,
  /web\.microsoftstream\.com$/i,
  /\.sharepoint\.com$/i,
  /player\.vimeo\.com$/i,
  /stream\.mux\.com$/i,
  /fast\.wistia\.(com|net)$/i,
  /vidyard\.com$/i,
  /brightcove(cdn)?\.com$/i,
  /jwplatform\.com$/i,
  /kaltura\.com$/i,
  /cloudfront\.net$/i,       // many CDNs host video players here
  /akamaihd\.net$/i,
  /cdn\.embedly\.com$/i,
  /embed\.api\.video$/i,
  /iframe\.mediadelivery\.net$/i, // Bunny.net
  /player\.cloudinary\.com$/i,
];

/**
 * URL path segments that strongly suggest a video embed.
 */
const VIDEO_PATH_KEYWORDS = [
  '/embed/', '/video/', '/player/', '/video-aes/',
  '/e/', '/v/', '/play/', '/watch/',
];

/**
 * Patterns in HTML source that indicate stream manifest URLs.
 */
const MANIFEST_PATTERNS = [
  // Direct .m3u8 / .mpd URLs (quoted)
  /["'](https?:\/\/[^"'\s]+\.m3u8(?:\?[^"'\s]*)?)["']/gi,
  /["'](https?:\/\/[^"'\s]+\.mpd(?:\?[^"'\s]*)?)["']/gi,
  // Relative manifest paths
  /["'](\/[^"'\s]+\.m3u8(?:\?[^"'\s]*)?)["']/gi,
  /["'](\/[^"'\s]+\.mpd(?:\?[^"'\s]*)?)["']/gi,
];


// ── Public API ──────────────────────────────────────────────────────

/**
 * Determine whether an iframe src URL looks like a video embed.
 *
 * @param {string} src — the iframe's src attribute
 * @returns {{ isVideo: boolean, confidence: 'high'|'medium'|'low', platform: string|null }}
 */
export function classifyIframe(src) {
  if (!src) return { isVideo: false, confidence: 'low', platform: null };

  let url;
  try { url = new URL(src); } catch { return { isVideo: false, confidence: 'low', platform: null }; }

  // Check against known domains (high confidence)
  for (const re of KNOWN_VIDEO_DOMAINS) {
    if (re.test(url.hostname)) {
      return { isVideo: true, confidence: 'high', platform: url.hostname };
    }
  }

  // Check path keywords (medium confidence)
  const pathLower = url.pathname.toLowerCase();
  for (const kw of VIDEO_PATH_KEYWORDS) {
    if (pathLower.includes(kw)) {
      return { isVideo: true, confidence: 'medium', platform: url.hostname };
    }
  }

  return { isVideo: false, confidence: 'low', platform: null };
}

/**
 * Extract authentication tokens from an iframe URL.
 *
 * Looks for JWT tokens in query params (at=, token=, auth=, jwt=, access_token=),
 * and returns them as a map. Tokens are ephemeral — never persisted.
 *
 * @param {string} src
 * @returns {Record<string, string>}
 */
export function extractAuthTokens(src) {
  const tokens = {};
  let url;
  try { url = new URL(src); } catch { return tokens; }

  const AUTH_PARAMS = ['at', 'token', 'auth', 'jwt', 'access_token', 'key', 'sig', 'signature'];
  for (const param of AUTH_PARAMS) {
    const val = url.searchParams.get(param);
    if (val && val.length > 8) { // ignore trivially short values
      tokens[param] = val;
    }
  }

  return tokens;
}

/**
 * Build request headers for authenticated fetches to the video platform.
 *
 * @param {Record<string, string>} tokens — from extractAuthTokens
 * @param {object[]} cookies — from chrome.cookies.getAll
 * @returns {HeadersInit}
 */
export function buildAuthHeaders(tokens, cookies = []) {
  const headers = {};

  // If we have a JWT-like token, attach as Bearer
  const jwt = tokens.at || tokens.token || tokens.jwt || tokens.access_token;
  if (jwt && jwt.includes('.')) {
    headers['Authorization'] = `Bearer ${jwt}`;
  }

  // Forward cookies as a header
  if (cookies.length > 0) {
    headers['Cookie'] = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  }

  return headers;
}

/**
 * Fetch an embed page and extract manifest URLs from its HTML source.
 *
 * @param {string} embedUrl — the iframe src
 * @param {HeadersInit} authHeaders — from buildAuthHeaders
 * @returns {Promise<{ manifests: string[] }>}
 */
export async function resolveManifestsFromEmbed(embedUrl, authHeaders = {}) {
  const res = await fetch(embedUrl, {
    headers: { ...authHeaders },
    credentials: 'include',
  });

  if (!res.ok) {
    throw new Error(`Embed fetch failed: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  return parseEmbedHtml(html, embedUrl);
}

/**
 * Parse embed page HTML for manifest URLs and DRM indicators.
 *
 * @param {string} html
 * @param {string} baseUrl — used to resolve relative manifest paths
 * @returns {{ manifests: string[] }}
 */
export function parseEmbedHtml(html, baseUrl) {
  const manifests = new Set();

  for (const pattern of MANIFEST_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(html))) {
      const raw = match[1];
      try {
        const absolute = new URL(raw, baseUrl).href;
        manifests.add(absolute);
      } catch { /* skip malformed URLs */ }
    }
  }

  return {
    manifests: Array.from(manifests),
  };
}

/**
 * Get the configurable list of known domains (for the options page).
 */
export function getKnownDomains() {
  return KNOWN_VIDEO_DOMAINS.map(re => re.source);
}

/**
 * @returns {string[]} The path keywords used for detection.
 */
export function getPathKeywords() {
  return [...VIDEO_PATH_KEYWORDS];
}
