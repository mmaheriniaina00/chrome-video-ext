/**
 * Background service worker — coordinates content scripts, popup, and
 * downloads. Handles network interception, iframe stream resolution,
 * AES-encrypted segment assembly, and auth forwarding.
 */

import { extFromUrl, extFromMime, filenameFromUrl, formatBytes } from '../utils/formats.js';
import {
  parseMasterPlaylist, parseMediaPlaylistDetailed,
  isMasterPlaylist, isHlsPlaylist, isAesEncrypted,
} from '../utils/hls-parser.js';
import { parseMpd, isDashManifest } from '../utils/dash-parser.js';
import {
  classifyIframe, extractAuthTokens, buildAuthHeaders,
  resolveManifestsFromEmbed,
} from '../utils/iframe-resolver.js';
import {
  startSegmentDownload, pauseDownload, resumeDownload,
  cancelDownload, getJobState, listJobs,
} from '../utils/segment-downloader.js';
import {
  createFetcherSet, fetchWithStrategy, fetchTextWithStrategy,
  getCookiesForUrl,
} from '../utils/fetch-strategy.js';

// ── Network-level video detection ───────────────────────────────────

/**
 * Per-tab map of video URLs discovered via network interception.
 * @type {Map<number, Map<string, NetworkVideo>>}
 */
const networkVideos = new Map();

/**
 * Per-tab map of manifest URLs discovered via network interception.
 * These are .m3u8 / .mpd URLs from iframe origins.
 * @type {Map<number, Map<string, string>>}
 */
const networkManifests = new Map();

const VIDEO_CONTENT_TYPES = [
  'video/', 'application/vnd.apple.mpegurl', 'application/x-mpegurl',
  'application/dash+xml',
];

const VIDEO_URL_RE = /\.(mp4|webm|ogv|mkv|m3u8|mpd)(\?|#|$)/i;
const MANIFEST_URL_RE = /\.(m3u8|mpd)(\?|#|$)/i;
const SEGMENT_URL_RE = /\.(ts|m4s|m4v|m4a|m4i)(\?|#|$)/i;
const KEY_URL_RE = /\.(key|bin)(\?|#|$)/i;
const INIT_SEGMENT_RE = /\.(m4i|m4s|m4v|m4a)(\?|#|$)/i;

/**
 * Filenames that indicate a sub-resource of a master manifest, not a
 * standalone downloadable. These clutter the UI.
 */
const SUB_RESOURCE_NAMES = /\/(index|chunklist|media|segment|init|initSection)[-_\w]*\.m3u8(\?|#|$)/i;

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;

    const contentType = details.responseHeaders
      ?.find(h => h.name.toLowerCase() === 'content-type')?.value || '';

    const isVideoMime = VIDEO_CONTENT_TYPES.some(t =>
      contentType.toLowerCase().includes(t));
    const isVideoExt = VIDEO_URL_RE.test(details.url);
    const isManifest = MANIFEST_URL_RE.test(details.url);

    if (!isVideoMime && !isVideoExt) return;

    const contentLength = details.responseHeaders
      ?.find(h => h.name.toLowerCase() === 'content-length')?.value;

    // Track manifests separately for iframe resolution
    if (isManifest) {
      if (!networkManifests.has(details.tabId)) {
        networkManifests.set(details.tabId, new Map());
      }
      networkManifests.get(details.tabId).set(details.url, contentType);
    }

    // Track videos
    if (!networkVideos.has(details.tabId)) {
      networkVideos.set(details.tabId, new Map());
    }
    const tabMap = networkVideos.get(details.tabId);

    // Skip individual segments, init segments, keys, and sub-resource playlists
    if (SEGMENT_URL_RE.test(details.url) || KEY_URL_RE.test(details.url)) return;
    if (INIT_SEGMENT_RE.test(details.url)) return;
    if (SUB_RESOURCE_NAMES.test(details.url)) return;

    if (!tabMap.has(details.url)) {
      tabMap.set(details.url, {
        url: details.url,
        type: isManifest ? 'stream' : 'direct',
        mime: contentType.split(';')[0].trim() || null,
        size: contentLength ? parseInt(contentLength, 10) : null,
        width: null,
        height: null,
        duration: null,
        poster: null,
        title: '',
      });
    }

    updateBadge(details.tabId);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

// Clean up when a tab closes.
chrome.tabs.onRemoved.addListener((tabId) => {
  networkVideos.delete(tabId);
  networkManifests.delete(tabId);
});

// Reset on navigation.
chrome.webNavigation?.onCommitted?.addListener((details) => {
  if (details.frameId === 0) {
    networkVideos.delete(details.tabId);
    networkManifests.delete(details.tabId);
    updateBadge(details.tabId);
  }
});

// ── Badge ───────────────────────────────────────────────────────────

function updateBadge(tabId) {
  const count = networkVideos.get(tabId)?.size || 0;
  chrome.action.setBadgeText({
    text: count > 0 ? String(count) : '',
    tabId,
  });
  chrome.action.setBadgeBackgroundColor({ color: '#6C5CE7', tabId });
}

// ── Simple (non-stream) download management ─────────────────────────

/** @type {Map<number, { downloadId: number, url: string, tabId: number }>} */
const activeDownloads = new Map();

async function startSimpleDownload(url, filename, tabId) {
  const settings = await chrome.storage.sync.get({
    defaultFormat: '',
    downloadPath: '',
  });

  const opts = { url };

  if (filename) {
    opts.filename = settings.downloadPath
      ? `${settings.downloadPath}/${filename}`
      : filename;
  }

  if (settings.defaultFormat && filename) {
    const ext = settings.defaultFormat;
    opts.filename = opts.filename.replace(/\.\w+$/, `.${ext}`);
  }

  return new Promise((resolve, reject) => {
    chrome.downloads.download(opts, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      activeDownloads.set(downloadId, { downloadId, url, tabId });
      resolve(downloadId);
    });
  });
}

// Relay download progress to the popup.
chrome.downloads.onChanged.addListener((delta) => {
  const info = activeDownloads.get(delta.id);
  if (!info) return;

  const update = { downloadId: delta.id };

  if (delta.state) {
    update.state = delta.state.current;
    if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
      activeDownloads.delete(delta.id);
    }
  }

  if (delta.error) {
    update.error = delta.error.current;
  }

  chrome.runtime.sendMessage({ action: 'downloadProgress', ...update }).catch(() => {});
});

// Periodic progress polling.
setInterval(async () => {
  for (const [downloadId] of activeDownloads) {
    try {
      const [item] = await chrome.downloads.search({ id: downloadId });
      if (item) {
        chrome.runtime.sendMessage({
          action: 'downloadProgress',
          downloadId,
          bytesReceived: item.bytesReceived,
          totalBytes: item.totalBytes,
          state: item.state,
        }).catch(() => {});
      }
    } catch { /* popup may be closed */ }
  }
}, 500);

// ── Auth forwarding ─────────────────────────────────────────────────
// getCookiesForUrl is now imported from fetch-strategy.js

/**
 * Build full auth context for a video platform URL (iframe resolution).
 */
async function buildFullAuthHeaders(platformUrl) {
  const tokens = extractAuthTokens(platformUrl);
  const cookies = await getCookiesForUrl(platformUrl);
  return buildAuthHeaders(tokens, cookies);
}

// ── HLS quality expansion (enhanced) ────────────────────────────────

async function expandHls(masterUrl, authHeaders = {}, tabId = null) {
  try {
    const ctx = { tabId, authHeaders };
    const body = await fetchTextWithStrategy(masterUrl, 'manifest', ctx);

    if (!isHlsPlaylist(body)) return { variants: [], encrypted: false };

    if (!isMasterPlaylist(body)) {
      const detail = parseMediaPlaylistDetailed(body, masterUrl);
      return {
        variants: [{ url: masterUrl, label: 'Default', bandwidth: 0, width: null, height: null }],
        encrypted: detail.encrypted,
      };
    }

    const variants = parseMasterPlaylist(body, masterUrl);
    let encrypted = false;
    if (variants.length > 0) {
      try {
        const vBody = await fetchTextWithStrategy(variants[0].url, 'manifest', ctx);
        encrypted = isAesEncrypted(vBody);
      } catch { /* best effort */ }
    }

    return { variants, encrypted };
  } catch {
    return { variants: [], encrypted: false };
  }
}

// ── DASH quality expansion ──────────────────────────────────────────

async function expandDash(mpdUrl, authHeaders = {}, tabId = null) {
  try {
    const ctx = { tabId, authHeaders };
    const body = await fetchTextWithStrategy(mpdUrl, 'manifest', ctx);

    if (!isDashManifest(body)) return { video: [], audio: [] };

    return parseMpd(body, mpdUrl);
  } catch {
    return { video: [], audio: [] };
  }
}

// ── Iframe stream resolution ────────────────────────────────────────

async function resolveIframe(iframeUrl, tabId) {
  const authHeaders = await buildFullAuthHeaders(iframeUrl);

  // Strategy 1: Check if we already intercepted manifests from this origin
  const tabManifests = networkManifests.get(tabId);
  if (tabManifests) {
    const iframeOrigin = new URL(iframeUrl).origin;
    const matchingManifests = [];
    for (const [url] of tabManifests) {
      if (url.startsWith(iframeOrigin) || MANIFEST_URL_RE.test(url)) {
        matchingManifests.push(url);
      }
    }
    if (matchingManifests.length > 0) {
      return { manifests: matchingManifests, authHeaders };
    }
  }

  // Strategy 2: Fetch embed page and parse for manifest URLs
  try {
    const result = await resolveManifestsFromEmbed(iframeUrl, authHeaders);
    return { ...result, authHeaders };
  } catch (err) {
    return { manifests: [], authHeaders, error: err.message };
  }
}

/** jobId → { videoUrl } so a reopened popup can re-attach to running jobs. */
const jobMeta = new Map();

// ── Blob handoff + keepalive ────────────────────────────────────────

/** Keep the service worker alive while long downloads run. */
let keepAliveTimer = null;
let keepAliveCount = 0;

function keepAliveStart() {
  if (keepAliveCount++ === 0) {
    keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  }
}

function keepAliveStop() {
  if (--keepAliveCount <= 0) {
    keepAliveCount = 0;
    clearInterval(keepAliveTimer);
  }
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) return;
  await chrome.offscreen.createDocument({
    url: 'src/offscreen/offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Create a blob URL for the assembled video file',
  });
}

/** Store blob in IndexedDB, have the offscreen document turn it into a blob: URL. */
async function blobToUrl(blob) {
  const key = `blob_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('vd-blobs', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('blobs');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').put(blob, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();

  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', action: 'makeBlobUrl', key });
  if (res?.error) throw new Error(res.error);
  return res.url;
}

// ── Stream download orchestration ───────────────────────────────────

/**
 * Download an HLS stream: resolve manifest → fetch segments → decrypt → assemble.
 */
async function downloadHlsStream(opts) {
  keepAliveStart();
  try {
    return await downloadHlsStreamInner(opts);
  } finally {
    keepAliveStop();
  }
}

async function downloadHlsStreamInner(opts) {
  const { variantUrl, authHeaders = {}, filename, tabId, jobId } = opts;

  const fetchers = createFetcherSet(tabId, authHeaders);

  const body = await fetchTextWithStrategy(variantUrl, 'manifest', { tabId, authHeaders });
  const playlist = parseMediaPlaylistDetailed(body, variantUrl);

  const ext = 'ts';
  const finalFilename = filename || `video_${Date.now()}.${ext}`;

  return new Promise((resolve, reject) => {
    startSegmentDownload({
      jobId,
      segments: playlist.segments.map(seg => ({
        url: seg.url,
        sequence: seg.sequence,
        key: seg.key,
      })),
      initSegment: null,
      outputExt: ext,
      keyFetcher: fetchers.keyFetcher,
      segmentFetcher: fetchers.segmentFetcher,
      onProgress: (job) => {
        chrome.runtime.sendMessage({
          action: 'streamProgress',
          jobId,
          ...job,
          speed: job.totalBytes / ((Date.now() - job.startTime) / 1000),
        }).catch(() => {});
      },
      onComplete: async (blob) => {
        try {
          const url = await blobToUrl(blob);
          const downloadId = await startSimpleDownload(url, finalFilename, tabId);
          resolve({ downloadId, jobId });
        } catch (err) {
          reject(err);
        }
      },
      onError: reject,
    });
  });
}

/**
 * Download a DASH stream: resolve MPD → fetch segments → assemble.
 */
async function downloadDashStream(opts) {
  keepAliveStart();
  try {
    return await downloadDashStreamInner(opts);
  } finally {
    keepAliveStop();
  }
}

async function downloadDashStreamInner(opts) {
  const { representationId, mpdUrl, authHeaders = {}, filename, tabId, jobId } = opts;

  const fetchers = createFetcherSet(tabId, authHeaders);

  const body = await fetchTextWithStrategy(mpdUrl, 'manifest', { tabId, authHeaders });
  const mpd = parseMpd(body, mpdUrl);

  const allReps = [...mpd.video, ...mpd.audio];
  const rep = allReps.find(r => r.id === representationId) || mpd.video[0];
  if (!rep) throw new Error('No representation found');

  let initSegment = null;
  if (rep.initUrl) {
    initSegment = await fetchWithStrategy(rep.initUrl, 'segment', { tabId, authHeaders });
  }

  const ext = 'mp4';
  const finalFilename = filename || `video_${Date.now()}.${ext}`;

  return new Promise((resolve, reject) => {
    startSegmentDownload({
      jobId,
      segments: rep.segmentUrls.map((url, i) => ({
        url,
        sequence: i,
        key: null,
      })),
      initSegment,
      outputExt: ext,
      keyFetcher: fetchers.keyFetcher,
      segmentFetcher: fetchers.segmentFetcher,
      onProgress: (job) => {
        chrome.runtime.sendMessage({
          action: 'streamProgress',
          jobId,
          ...job,
          speed: job.totalBytes / ((Date.now() - job.startTime) / 1000),
        }).catch(() => {});
      },
      onComplete: async (blob) => {
        try {
          const url = await blobToUrl(blob);
          const downloadId = await startSimpleDownload(url, finalFilename, tabId);
          resolve({ downloadId, jobId });
        } catch (err) {
          reject(err);
        }
      },
      onError: reject,
    });
  });
}

// ── Message handler ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') return; // handled by the offscreen document
  handleMessage(msg, sender).then(sendResponse).catch((err) => {
    sendResponse({ error: err.message });
  });
  return true; // async
});

async function handleMessage(msg, _sender) {
  switch (msg.action) {
    // ── Existing actions ──

    case 'getNetworkVideos': {
      const tabId = msg.tabId;
      const map = networkVideos.get(tabId);
      return { videos: map ? Array.from(map.values()) : [] };
    }

    case 'download': {
      const ext = extFromUrl(msg.url) || extFromMime(msg.mime) || 'mp4';
      const filename = msg.filename || filenameFromUrl(msg.url, ext);
      const downloadId = await startSimpleDownload(msg.url, filename, msg.tabId);
      return { downloadId };
    }

    case 'expandHls': {
      const authHeaders = msg.authHeaders || {};
      const result = await expandHls(msg.url, authHeaders, msg.tabId || null);
      return result;
    }

    case 'getDownloadState': {
      const states = {};
      for (const [id] of activeDownloads) {
        try {
          const [item] = await chrome.downloads.search({ id });
          if (item) states[id] = item;
        } catch { /* ignore */ }
      }
      return { states };
    }

    // ── New iframe/stream actions ──

    case 'resolveIframe': {
      return await resolveIframe(msg.url, msg.tabId);
    }

    case 'expandDash': {
      const authHeaders = msg.authHeaders || {};
      const result = await expandDash(msg.url, authHeaders, msg.tabId || null);
      return result;
    }

    case 'downloadStream': {
      const jobId = msg.jobId || `stream_${Date.now()}`;
      const authHeaders = msg.authHeaders || {};
      const dupKey = `${msg.url}|${msg.representationId || ''}`;
      const dup = listJobs().find(j =>
        (j.state === 'running' || j.state === 'paused') && jobMeta.get(j.id)?.dupKey === dupKey);
      if (dup) return { alreadyRunning: true, jobId: dup.id };
      jobMeta.set(jobId, { videoUrl: msg.videoUrl || msg.url, dupKey });

      if (msg.streamType === 'dash') {
        return await downloadDashStream({
          representationId: msg.representationId,
          mpdUrl: msg.url,
          authHeaders,
          filename: msg.filename,
          tabId: msg.tabId,
          jobId,
        });
      } else {
        // Default to HLS
        return await downloadHlsStream({
          variantUrl: msg.url,
          authHeaders,
          filename: msg.filename,
          tabId: msg.tabId,
          jobId,
        });
      }
    }

    case 'pauseStream': {
      pauseDownload(msg.jobId);
      return { ok: true };
    }

    case 'resumeStream': {
      resumeDownload(msg.jobId);
      return { ok: true };
    }

    case 'cancelStream': {
      cancelDownload(msg.jobId);
      return { ok: true };
    }

    case 'getStreamJobs': {
      return {
        jobs: listJobs().map(j => ({
          id: j.id,
          state: j.state,
          totalSegments: j.totalSegments,
          completedSegments: j.completedSegments,
          totalBytes: j.totalBytes,
          startTime: j.startTime,
          error: j.error,
          videoUrl: jobMeta.get(j.id)?.videoUrl,
        })),
      };
    }

    case 'getStreamJobState': {
      return { job: getJobState(msg.jobId) };
    }

    case 'getAuthHeaders': {
      const headers = await buildFullAuthHeaders(msg.url);
      return { headers };
    }

    default:
      return { error: 'Unknown action' };
  }
}
