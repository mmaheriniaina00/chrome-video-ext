/**
 * Minimal DASH (MPD) parser.
 *
 * Parses DASH manifests to extract adaptation sets, representations,
 * and segment URLs for quality selection and download.
 */

/**
 * @typedef {Object} DashRepresentation
 * @property {string}      id          — representation ID
 * @property {string}      url         — absolute URL of the media (or template)
 * @property {number}      bandwidth   — bits per second
 * @property {number|null} width
 * @property {number|null} height
 * @property {string}      codecs
 * @property {string}      mimeType
 * @property {string}      label       — human-readable quality string
 * @property {string|null} initUrl     — initialization segment URL
 * @property {string[]}    segmentUrls — ordered list of media segment URLs
 * @property {boolean}     hasDrm      — whether ContentProtection elements are present
 */

/**
 * Parse a DASH MPD manifest.
 *
 * @param {string} xml      — raw MPD XML text
 * @param {string} baseUrl  — base URL used to resolve relative URIs
 * @returns {{ video: DashRepresentation[], audio: DashRepresentation[], hasDrm: boolean }}
 */
export function parseMpd(xml, baseUrl) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'application/xml');

  if (doc.querySelector('parsererror')) {
    throw new Error('Failed to parse MPD XML');
  }

  const mpd = doc.documentElement;

  // Resolve BaseURL if present
  const mpdBase = resolveBaseUrl(mpd, baseUrl);

  const video = [];
  const audio = [];
  let hasDrm = false;

  const periods = mpd.querySelectorAll('Period');
  for (const period of periods) {
    const periodBase = resolveBaseUrl(period, mpdBase);

    const adaptationSets = period.querySelectorAll('AdaptationSet');
    for (const as of adaptationSets) {
      const asBase = resolveBaseUrl(as, periodBase);
      const asMime = as.getAttribute('mimeType') || '';
      const asCodecs = as.getAttribute('codecs') || '';
      const contentType = as.getAttribute('contentType') || asMime.split('/')[0] || '';

      // DRM detection
      const cpElements = as.querySelectorAll('ContentProtection');
      if (cpElements.length > 0) hasDrm = true;

      const representations = as.querySelectorAll('Representation');
      for (const rep of representations) {
        const repBase = resolveBaseUrl(rep, asBase);
        const mimeType = rep.getAttribute('mimeType') || asMime;
        const codecs = rep.getAttribute('codecs') || asCodecs;
        const bandwidth = parseInt(rep.getAttribute('bandwidth'), 10) || 0;
        const width = parseInt(rep.getAttribute('width'), 10) || null;
        const height = parseInt(rep.getAttribute('height'), 10) || null;
        const id = rep.getAttribute('id') || '';

        // Check rep-level DRM too
        const repCp = rep.querySelectorAll('ContentProtection');
        if (repCp.length > 0) hasDrm = true;

        // Resolve segments
        const { initUrl, segmentUrls } = resolveSegments(rep, as, period, repBase);

        const label = buildLabel(width, height, bandwidth, codecs);

        const entry = {
          id,
          url: repBase,
          bandwidth,
          width,
          height,
          codecs,
          mimeType,
          label,
          initUrl,
          segmentUrls,
          hasDrm: cpElements.length > 0 || repCp.length > 0,
        };

        const type = contentType || mimeType.split('/')[0];
        if (type === 'video') {
          video.push(entry);
        } else if (type === 'audio') {
          audio.push(entry);
        } else if (width || height) {
          video.push(entry); // infer video if dimensions present
        }
      }
    }
  }

  // Sort by bandwidth descending (highest quality first)
  video.sort((a, b) => b.bandwidth - a.bandwidth);
  audio.sort((a, b) => b.bandwidth - a.bandwidth);

  return { video, audio, hasDrm };
}

/**
 * Detect whether text looks like a DASH MPD manifest.
 */
export function isDashManifest(text) {
  return typeof text === 'string' && text.includes('<MPD');
}

// ── Internal helpers ────────────────────────────────────────────────

function resolveBaseUrl(element, fallback) {
  const baseEl = element.querySelector(':scope > BaseURL');
  if (baseEl?.textContent) {
    try {
      return new URL(baseEl.textContent.trim(), fallback).href;
    } catch { /* ignore */ }
  }
  return fallback;
}

function resolveSegments(rep, adaptationSet, period, baseUrl) {
  let initUrl = null;
  const segmentUrls = [];

  // SegmentList approach
  const segList = rep.querySelector('SegmentList') || adaptationSet.querySelector('SegmentList');
  if (segList) {
    const initEl = segList.querySelector('Initialization');
    if (initEl) {
      const src = initEl.getAttribute('sourceURL') || initEl.getAttribute('range');
      if (src) initUrl = resolveUrl(src, baseUrl);
    }
    for (const seg of segList.querySelectorAll('SegmentURL')) {
      const media = seg.getAttribute('media');
      if (media) segmentUrls.push(resolveUrl(media, baseUrl));
    }
    return { initUrl, segmentUrls };
  }

  // SegmentTemplate approach
  const segTmpl = rep.querySelector('SegmentTemplate')
    || adaptationSet.querySelector('SegmentTemplate')
    || period.querySelector('SegmentTemplate');

  if (segTmpl) {
    const initTmpl = segTmpl.getAttribute('initialization');
    const mediaTmpl = segTmpl.getAttribute('media');
    const repId = rep.getAttribute('id') || '0';
    const bandwidth = rep.getAttribute('bandwidth') || '0';
    const startNumber = parseInt(segTmpl.getAttribute('startNumber') || '1', 10);

    if (initTmpl) {
      initUrl = resolveUrl(
        fillTemplate(initTmpl, repId, bandwidth, 0),
        baseUrl,
      );
    }

    // SegmentTimeline
    const timeline = segTmpl.querySelector('SegmentTimeline');
    if (timeline) {
      let time = 0;
      let number = startNumber;
      for (const s of timeline.querySelectorAll('S')) {
        const t = parseInt(s.getAttribute('t'), 10);
        if (!isNaN(t)) time = t;
        const d = parseInt(s.getAttribute('d'), 10) || 0;
        const r = parseInt(s.getAttribute('r'), 10) || 0;

        for (let i = 0; i <= r; i++) {
          if (mediaTmpl) {
            segmentUrls.push(resolveUrl(
              fillTemplate(mediaTmpl, repId, bandwidth, number, time),
              baseUrl,
            ));
          }
          time += d;
          number++;
        }
      }
    } else {
      // Compute from duration + total duration
      const timescale = parseInt(segTmpl.getAttribute('timescale') || '1', 10);
      const duration = parseInt(segTmpl.getAttribute('duration') || '0', 10);
      const totalDuration = parseDuration(
        period.getAttribute('duration') ||
        rep.closest('MPD')?.getAttribute('mediaPresentationDuration') || ''
      );

      if (duration > 0 && totalDuration > 0) {
        const segmentDurationSec = duration / timescale;
        const count = Math.ceil(totalDuration / segmentDurationSec);
        for (let i = 0; i < count; i++) {
          const number = startNumber + i;
          const time = i * duration;
          if (mediaTmpl) {
            segmentUrls.push(resolveUrl(
              fillTemplate(mediaTmpl, repId, bandwidth, number, time),
              baseUrl,
            ));
          }
        }
      }
    }

    return { initUrl, segmentUrls };
  }

  // SegmentBase / BaseURL-only (single file)
  const segBase = rep.querySelector('SegmentBase');
  if (segBase) {
    const initRange = segBase.querySelector('Initialization')?.getAttribute('range');
    // For BaseURL-only, the entire file is at baseUrl
    segmentUrls.push(baseUrl);
    return { initUrl: initRange ? `${baseUrl}#range=${initRange}` : null, segmentUrls };
  }

  // Fallback: treat baseUrl as the media URL
  segmentUrls.push(baseUrl);
  return { initUrl, segmentUrls };
}

function fillTemplate(template, repId, bandwidth, number, time) {
  return template
    .replace(/\$RepresentationID\$/g, repId)
    .replace(/\$Bandwidth\$/g, bandwidth)
    .replace(/\$Number(?:%(\d+)d)?\$/g, (_m, pad) => {
      return pad ? String(number).padStart(parseInt(pad, 10), '0') : String(number);
    })
    .replace(/\$Time\$/g, String(time ?? 0));
}

function resolveUrl(relative, base) {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

/**
 * Parse an ISO 8601 duration (PT...H...M...S) to seconds.
 */
function parseDuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0, 10) * 3600) +
         (parseInt(m[2] || 0, 10) * 60) +
         parseFloat(m[3] || 0);
}
