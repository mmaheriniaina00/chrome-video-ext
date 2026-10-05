/**
 * Content script — scans the page for video sources (including
 * cross-origin iframes) and reports them to the background service
 * worker on demand.
 *
 * Runs in every frame (all_frames: true) at document_idle, then
 * watches for dynamically inserted media via MutationObserver.
 */

(() => {
  'use strict';

  // Guard against double-injection in the same frame.
  if (window.__videoDownloaderInjected) return;
  window.__videoDownloaderInjected = true;

  /** @type {Map<string, VideoInfo>} url → info */
  const found = new Map();

  /** @type {Map<string, IframeInfo>} iframe src → info */
  const foundIframes = new Map();

  // ── Known video embed patterns (must stay in sync with iframe-resolver) ─

  const KNOWN_VIDEO_DOMAINS = [
    /^www\.youtube\.com$/i,
    /^www\.youtube-nocookie\.com$/i,
    /medius\.microsoft\.com$/i,
    /microsoftstream\.com$/i,
    /web\.microsoftstream\.com$/i,
    /microsoft\.com.*\/video/i,         // any microsoft.com subdomain with /video path
    /\.sharepoint\.com$/i,              // SharePoint-hosted videos
    /player\.vimeo\.com$/i,
    /stream\.mux\.com$/i,
    /fast\.wistia\.(com|net)$/i,
    /vidyard\.com$/i,
    /brightcove(cdn)?\.com$/i,
    /jwplatform\.com$/i,
    /kaltura\.com$/i,
    /cloudfront\.net$/i,
    /akamaihd\.net$/i,
    /cdn\.embedly\.com$/i,
    /embed\.api\.video$/i,
    /iframe\.mediadelivery\.net$/i,
    /player\.cloudinary\.com$/i,
  ];

  const VIDEO_PATH_KEYWORDS = [
    '/embed/', '/video/', '/player/', '/video-aes/',
    '/e/', '/v/', '/play/', '/watch/',
  ];

  // ── Scanning ──────────────────────────────────────────────────────

  function scan() {
    scanVideoElements();
    scanSourceElements();
    scanObjectEmbed();
    scanNetworkHints();
    scanYouTubeThumbnails();
    scanIframes();
    scanComplianzBlockedVideos();
  }

  /** HTML5 <video> elements — with src, or poster-only (pending/lazy). */
  function scanVideoElements() {
    for (const el of document.querySelectorAll('video')) {
      const src = el.currentSrc || el.src;
      if (src) {
        addSource(src, el);
      } else if (el.poster || el.getAttribute('data-src')) {
        // Video element exists but hasn't loaded a stream yet (poster-only
        // or lazy-loaded). Surface it so the user knows a video is present
        // and can wait for it to start playing.
        const pendingSrc = el.getAttribute('data-src') || el.poster;
        if (pendingSrc && !found.has('pending:' + pendingSrc)) {
          found.set('pending:' + pendingSrc, {
            url: pendingSrc,
            type: 'pending',
            mime: 'video/mp4',
            width: el.videoWidth || el.width || null,
            height: el.videoHeight || el.height || null,
            duration: null,
            poster: el.poster || null,
            title: el.title || document.title || '',
          });
        }
      }

      // Also check nested <source> elements.
      for (const s of el.querySelectorAll('source')) {
        if (s.src) addSource(s.src, el, s.type);
      }
    }
  }

  /** Standalone <source> elements (e.g. inside <audio> that may carry video). */
  function scanSourceElements() {
    for (const s of document.querySelectorAll('source[src]')) {
      const type = (s.type || '').toLowerCase();
      if (type.startsWith('video/') || isVideoUrl(s.src)) {
        addSource(s.src, s.closest('video') || s, type);
      }
    }
  }

  /** <object> and <embed> fallbacks. */
  function scanObjectEmbed() {
    for (const el of document.querySelectorAll('object[data], embed[src]')) {
      const url = el.data || el.src;
      if (url && isVideoUrl(url)) addSource(url, null);
    }
  }

  /**
   * Look for video URLs hiding in data attributes, inline JSON-LD,
   * og:video meta tags, and common JS player config patterns.
   */
  function scanNetworkHints() {
    // og:video / og:video:url meta tags
    for (const meta of document.querySelectorAll(
      'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]'
    )) {
      const url = meta.content;
      if (url && isVideoUrl(url)) addSource(url, null);
    }

    // JSON-LD VideoObject
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent);
        extractJsonLdVideos(data);
      } catch { /* ignore malformed JSON-LD */ }
    }

    // Common data-* attributes
    for (const el of document.querySelectorAll('[data-video-src], [data-src], [data-url]')) {
      for (const attr of ['data-video-src', 'data-src', 'data-url']) {
        const val = el.getAttribute(attr);
        if (val && isVideoUrl(val)) addSource(val, el);
      }
    }
  }

  /**
   * Detect YouTube videos referenced only as thumbnail images
   * (common with Elementor click-to-play / lightbox patterns).
   * Extracts video IDs from img.youtube.com/vi/{ID}/ URLs and
   * surfaces them as iframe-type detections.
   */
  function scanYouTubeThumbnails() {
    const YT_THUMB_RE = /img\.youtube\.com\/vi\/([a-zA-Z0-9_-]{11})\//;
    const seen = new Set();

    // Check image src attributes
    for (const img of document.querySelectorAll('img[src*="img.youtube.com/vi/"]')) {
      const match = YT_THUMB_RE.exec(img.src);
      if (!match) continue;
      const videoId = match[1];
      if (seen.has(videoId)) continue;
      seen.add(videoId);

      const embedUrl = `https://www.youtube.com/embed/${videoId}`;
      if (foundIframes.has(embedUrl)) continue;

      foundIframes.set(embedUrl, {
        url: embedUrl,
        type: 'iframe-embed',
        platform: 'www.youtube.com',
        confidence: 'high',
        title: img.alt || img.title || document.title || '',
        width: null,
        height: null,
      });
    }

    // Also check anchor hrefs with youtube.com/watch?v= links
    for (const a of document.querySelectorAll('a[href*="youtube.com/watch"]')) {
      try {
        const url = new URL(a.href);
        const videoId = url.searchParams.get('v');
        if (!videoId || videoId.length !== 11 || seen.has(videoId)) continue;
        seen.add(videoId);

        const embedUrl = `https://www.youtube.com/embed/${videoId}`;
        if (foundIframes.has(embedUrl)) continue;

        foundIframes.set(embedUrl, {
          url: embedUrl,
          type: 'iframe-embed',
          platform: 'www.youtube.com',
          confidence: 'high',
          title: a.textContent?.trim() || a.title || '',
          width: null,
          height: null,
        });
      } catch { /* skip malformed URLs */ }
    }
  }

  /**
   * Scan all <iframe> elements on the page and classify them as
   * potential video embeds. Cross-origin iframes can't be accessed
   * via DOM, so we send their URLs to the background for resolution.
   */
  function scanIframes() {
    for (const iframe of document.querySelectorAll('iframe[src]')) {
      const src = iframe.src;
      if (!src || foundIframes.has(src)) continue;
      // Skip trivial/tracking iframes
      if (src.startsWith('about:') || src.startsWith('javascript:')) continue;

      let classification = classifyIframeSrc(src);

      // Iframes with allow="encrypted-media" are almost always video players,
      // even if the domain isn't in our allow-list.
      if (!classification.isVideo) {
        const allow = iframe.getAttribute('allow') || iframe.getAttribute('allowfullscreen');
        const hasVideoSignal =
          (iframe.getAttribute('allow') || '').includes('encrypted-media') ||
          (iframe.getAttribute('allow') || '').includes('autoplay') ||
          iframe.hasAttribute('allowfullscreen');

        if (hasVideoSignal) {
          try {
            classification = {
              isVideo: true,
              confidence: 'medium',
              platform: new URL(src).hostname,
            };
          } catch { continue; }
        }
      }

      if (!classification.isVideo) continue;

      foundIframes.set(src, {
        url: src,
        type: 'iframe-embed',
        platform: classification.platform,
        confidence: classification.confidence,
        title: iframe.title || iframe.getAttribute('aria-label') || document.title || '',
        width: iframe.width || iframe.clientWidth || null,
        height: iframe.height || iframe.clientHeight || null,
      });
    }
  }

  /**
   * Detect videos blocked by cookie consent managers (Complianz, CookieBot, etc.).
   *
   * Complianz replaces Elementor video widgets with placeholder elements:
   *   - Class "cmplz-elementor-widget-video-playlist" or
   *     "elementor-widget-video[data-category]" with blocked content
   *   - After consent, JS removes the cmplz- prefix and the video renders
   *
   * We scan for these placeholders and extract video config from Elementor's
   * data-settings JSON, which contains the youtube_url or video URL even
   * while blocked.
   */
  function scanComplianzBlockedVideos() {
    // Selectors for consent-blocked video widgets
    const selectors = [
      '.cmplz-elementor-widget-video-playlist[data-settings]',
      '.cmplz-blocked-content-container[data-settings]',
      '.elementor-widget-video[data-category][data-settings]',
      '.elementor-widget-video-playlist[data-category][data-settings]',
      // Also catch already-unblocked Elementor video widgets
      '.elementor-widget-video[data-settings]',
      '.elementor-widget-video-playlist[data-settings]',
    ];

    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        try {
          const settingsStr = el.getAttribute('data-settings');
          if (!settingsStr) continue;
          const settings = JSON.parse(settingsStr);

          // Extract video URL from Elementor widget settings
          const videoUrl = settings.youtube_url
            || settings.vimeo_url
            || settings.hosted_url?.url
            || settings.video_url
            || settings.insert_url;

          if (!videoUrl) continue;

          // Convert YouTube watch URLs to embed URLs
          let embedUrl = videoUrl;
          const ytMatch = videoUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
          if (ytMatch) {
            embedUrl = `https://www.youtube.com/embed/${ytMatch[1]}`;
          }

          if (foundIframes.has(embedUrl)) continue;

          const isBlocked = el.classList.contains('cmplz-elementor-widget-video-playlist')
            || el.classList.contains('cmplz-blocked-content-container');

          foundIframes.set(embedUrl, {
            url: embedUrl,
            type: 'iframe-embed',
            platform: extractPlatform(embedUrl),
            confidence: 'high',
            title: (isBlocked ? '[Cookie consent required] ' : '') + (document.title || ''),
            width: null,
            height: null,
          });
        } catch { /* skip malformed data-settings */ }
      }
    }
  }

  function extractPlatform(url) {
    try { return new URL(url).hostname; } catch { return null; }
  }

  /**
   * Classify an iframe src URL as a potential video embed.
   */
  function classifyIframeSrc(src) {
    let url;
    try { url = new URL(src); } catch { return { isVideo: false, confidence: 'low', platform: null }; }

    // Check known domains (high confidence)
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

  function extractJsonLdVideos(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(extractJsonLdVideos); return; }
    if (obj['@type'] === 'VideoObject' && obj.contentUrl) {
      addSource(obj.contentUrl, null);
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') extractJsonLdVideos(v);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────

  const VIDEO_EXT_RE = /\.(mp4|webm|ogv|mkv|mov|avi|flv|m3u8|mpd|ts)(\?|$)/i;

  function isVideoUrl(url) {
    if (!url) return false;
    return VIDEO_EXT_RE.test(url);
  }

  function addSource(rawUrl, videoEl, mime) {
    const url = absoluteUrl(rawUrl);
    if (!url || found.has(url)) return;
    if (url.startsWith('blob:')) return; // can't download cross-origin blobs

    const info = {
      url,
      type: 'direct',
      mime: mime || guessMime(url),
      width: videoEl?.videoWidth || videoEl?.width || null,
      height: videoEl?.videoHeight || videoEl?.height || null,
      duration: videoEl?.duration || null,
      poster: videoEl?.poster || null,
      title: videoEl?.title || document.title || '',
    };

    found.set(url, info);
  }

  function absoluteUrl(raw) {
    try {
      return new URL(raw, location.href).href;
    } catch {
      return null;
    }
  }

  function guessMime(url) {
    const ext = url.match(/\.(\w+)(\?|$)/)?.[1]?.toLowerCase();
    const map = {
      mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
      m3u8: 'application/vnd.apple.mpegurl', mpd: 'application/dash+xml',
    };
    return map[ext] || 'video/mp4';
  }

  // ── MutationObserver for SPA / lazy-loaded content ────────────────

  const observer = new MutationObserver((mutations) => {
    let dominated = false;
    for (const m of mutations) {
      // Watch for added nodes (new video elements, iframes injected after consent)
      for (const node of m.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.matches?.('video, source, object, embed, iframe') ||
              node.querySelector?.('video, source, object, embed, iframe')) {
            dominated = true;
            break;
          }
        }
      }
      // Watch for attribute changes (Complianz removes cmplz- class prefixes on consent)
      if (!dominated && m.type === 'attributes' && m.attributeName === 'class') {
        const el = m.target;
        if (el.classList?.contains('elementor-widget-video') ||
            el.classList?.contains('elementor-widget-video-playlist')) {
          dominated = true;
        }
      }
      if (dominated) break;
    }
    if (dominated) scan();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'], // catch Complianz consent-triggered class changes
  });

  // ── Messaging ─────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'getVideos') {
      scan(); // re-scan to catch anything new
      sendResponse({
        videos: Array.from(found.values()),
        iframes: Array.from(foundIframes.values()),
      });
    }

    // Strategy: content-script isolated world fetch (page cookies, extension CORS)
    if (msg.action === 'fetchResourceContentScript') {
      fetch(msg.url, { credentials: 'include' })
        .then(res => {
          if (!res.ok) throw new Error(`${res.status}`);
          return res.arrayBuffer();
        })
        .then(buf => sendResponse({ data: Array.from(new Uint8Array(buf)) }))
        .catch(err => sendResponse({ error: err.message }));
      return true;
    }

    return true; // keep channel open for async response
  });

  // Initial scan.
  scan();
})();
