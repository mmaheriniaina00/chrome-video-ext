/**
 * Fetch Strategy Chain — tries multiple download strategies in order of
 * likelihood of success, caches the winner per domain+operation, and
 * falls back automatically if a cached strategy fails mid-download.
 *
 * Strategies (tried in order):
 *   1. page-main-world  — fetch() injected into page's JS context (page's CORS + cookies)
 *   2. content-script    — fetch() in content script isolated world (page cookies, extension CORS)
 *   3. sw-cookies        — fetch() in service worker with manually-built Cookie header
 *   4. direct-fetch      — plain fetch() with credentials: include from service worker
 */

// ── Cookie helper (extracted from service-worker) ───────────────────

/**
 * Get cookies for a given URL's domain via chrome.cookies API.
 * Tries exact origin, hostname, then parent domain.
 */
export async function getCookiesForUrl(url) {
  try {
    const parsed = new URL(url);
    let cookies = await chrome.cookies.getAll({ url: parsed.origin });
    if (cookies.length === 0) {
      cookies = await chrome.cookies.getAll({ domain: parsed.hostname });
    }
    if (cookies.length === 0) {
      const parts = parsed.hostname.split('.');
      if (parts.length > 2) {
        const parentDomain = '.' + parts.slice(-2).join('.');
        cookies = await chrome.cookies.getAll({ domain: parentDomain });
      }
    }
    return cookies;
  } catch {
    return [];
  }
}

// ── Strategy definitions ────────────────────────────────────────────

const STRATEGIES = [
  {
    name: 'page-main-world',
    available: (ctx) => ctx.tabId != null,
    execute: async (url, ctx) => {
      // Use chrome.scripting.executeScript with world: 'MAIN' to run
      // fetch() in the page's actual JS context. This bypasses the page's
      // CSP (unlike <script> injection) and inherits the page's CORS + cookies.
      const results = await chrome.scripting.executeScript({
        target: { tabId: ctx.tabId },
        world: 'MAIN',
        func: async (fetchUrl) => {
          try {
            const res = await fetch(fetchUrl, { credentials: 'include' });
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            const buf = await res.arrayBuffer();
            const bytes = new Uint8Array(buf);
            // Convert to regular array for serialization across worlds
            const arr = [];
            for (let i = 0; i < bytes.length; i++) arr.push(bytes[i]);
            return { data: arr };
          } catch (err) {
            return { error: err.message };
          }
        },
        args: [url],
      });

      const result = results?.[0]?.result;
      if (!result) throw new Error('No result from page context');
      if (result.error) throw new Error(result.error);
      if (!result.data?.length) throw new Error('Empty response');
      return new Uint8Array(result.data).buffer;
    },
  },
  {
    name: 'content-script',
    available: (ctx) => ctx.tabId != null,
    execute: async (url, ctx) => {
      const response = await chrome.tabs.sendMessage(ctx.tabId, {
        action: 'fetchResourceContentScript',
        url,
      });
      if (response?.error) throw new Error(response.error);
      if (!response?.data) throw new Error('Empty response');
      return new Uint8Array(response.data).buffer;
    },
  },
  {
    name: 'sw-cookies',
    available: () => true,
    execute: async (url, ctx) => {
      const headers = { ...(ctx.authHeaders || {}) };
      if (!headers.Cookie) {
        const cookies = await getCookiesForUrl(url);
        if (cookies.length) {
          headers.Cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        }
      }
      const res = await fetch(url, { headers, signal: ctx.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    },
  },
  {
    name: 'direct-fetch',
    available: () => true,
    execute: async (url, ctx) => {
      const res = await fetch(url, {
        headers: ctx.authHeaders || {},
        credentials: 'include',
        signal: ctx.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    },
  },
];

// ── Domain strategy cache ───────────────────────────────────────────
// Key: "domain:operationType" → strategy name
const cache = new Map();

function cacheKey(domain, opType) {
  return `${domain}:${opType}`;
}

/**
 * Clear cached strategies. Call when auth state changes.
 * @param {string} [domain] — specific domain, or omit to clear all
 */
export function clearCache(domain) {
  if (domain) {
    for (const key of cache.keys()) {
      if (key.startsWith(domain + ':')) cache.delete(key);
    }
  } else {
    cache.clear();
  }
}

// ── Core fetch function ─────────────────────────────────────────────

/**
 * Fetch a URL using the strategy chain. Tries the cached strategy first;
 * on failure, falls through to the full chain and updates the cache.
 *
 * @param {string} url
 * @param {'manifest'|'key'|'segment'} operationType
 * @param {{ tabId: number|null, authHeaders?: HeadersInit, signal?: AbortSignal }} context
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchWithStrategy(url, operationType, context) {
  let domain;
  try { domain = new URL(url).hostname; } catch { domain = 'unknown'; }

  const ck = cacheKey(domain, operationType);

  // Try cached strategy first
  const cachedName = cache.get(ck);
  if (cachedName) {
    const strategy = STRATEGIES.find(s => s.name === cachedName);
    if (strategy?.available(context)) {
      try {
        const result = await withTimeout(strategy.execute(url, context), 30000);
        return result;
      } catch {
        // Cached strategy failed — clear and fall through to full chain
        cache.delete(ck);
      }
    }
  }

  // Full chain — try each strategy in order
  const errors = [];
  for (const strategy of STRATEGIES) {
    if (!strategy.available(context)) continue;

    try {
      const result = await withTimeout(strategy.execute(url, context), 30000);
      // Success — cache this strategy for future fetches
      cache.set(ck, strategy.name);
      return result;
    } catch (err) {
      errors.push(`${strategy.name}: ${err.message}`);
    }
  }

  throw new Error(
    `All fetch strategies failed for ${operationType} ${url}\n` +
    errors.map(e => `  - ${e}`).join('\n')
  );
}

/**
 * Fetch text content using the strategy chain.
 */
export async function fetchTextWithStrategy(url, operationType, context) {
  const buf = await fetchWithStrategy(url, operationType, context);
  return new TextDecoder().decode(buf);
}

// ── Convenience: create bound fetchers for a download job ───────────

/**
 * Create a set of fetcher functions bound to a specific tab and auth context.
 * Pass these directly into startSegmentDownload().
 *
 * @param {number|null} tabId
 * @param {HeadersInit} [authHeaders={}]
 * @returns {{ manifestFetcher, keyFetcher, segmentFetcher }}
 */
export function createFetcherSet(tabId, authHeaders = {}) {
  const ctx = { tabId, authHeaders };

  return {
    manifestFetcher: (url) => fetchWithStrategy(url, 'manifest', ctx),
    keyFetcher: (url) => fetchWithStrategy(url, 'key', ctx),
    segmentFetcher: (url) => fetchWithStrategy(url, 'segment', ctx),
  };
}

// ── Probe (optional explicit pre-test) ──────────────────────────────

/**
 * Pre-test which strategy works for a domain + operation type.
 * Returns the winning strategy name. The result is cached.
 *
 * @param {string} sampleUrl — a URL on the target domain to test
 * @param {'manifest'|'key'|'segment'} operationType
 * @param {{ tabId: number|null, authHeaders?: HeadersInit }} context
 * @returns {Promise<string>} — winning strategy name
 */
export async function probe(sampleUrl, operationType, context) {
  // fetchWithStrategy already probes and caches — just discard the data
  await fetchWithStrategy(sampleUrl, operationType, context);
  const domain = new URL(sampleUrl).hostname;
  return cache.get(cacheKey(domain, operationType)) || 'unknown';
}

// ── Internal helpers ────────────────────────────────────────────────

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
