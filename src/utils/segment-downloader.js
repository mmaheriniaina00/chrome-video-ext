/**
 * Segment Downloader — fetches, decrypts, and concatenates HLS/DASH
 * segments into a single file. Supports pause/resume, retry with
 * exponential backoff, and real-time progress reporting.
 *
 * Fetching is fully delegated to caller-provided `keyFetcher` and
 * `segmentFetcher` callbacks (typically from the fetch strategy chain).
 */

import {
  importAesKey,
  decryptSegment,
  ivFromSequenceNumber,
  ivFromHex,
} from './aes-decrypt.js';

// ── Constants ───────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_CONCURRENT = 4;

// ── Active jobs registry ────────────────────────────────────────────

/** @type {Map<string, DownloadJob>} */
const jobs = new Map();

/** @type {Map<string, AbortController>} */
const abortControllers = new Map();

/** @type {Map<string, ArrayBuffer[]>} */
const segmentBuffers = new Map();

// ── Public API ──────────────────────────────────────────────────────

/**
 * Start downloading and assembling segments.
 *
 * @param {Object} opts
 * @param {string}        opts.jobId          — unique identifier
 * @param {SegmentSpec[]} opts.segments        — ordered list of segments
 * @param {ArrayBuffer|null} opts.initSegment — DASH init segment (prepended to output)
 * @param {string}        opts.outputExt       — 'ts', 'mp4', etc.
 * @param {Function}      opts.keyFetcher      — async (keyUri) => ArrayBuffer
 * @param {Function}      opts.segmentFetcher  — async (url) => ArrayBuffer
 * @param {Function}      opts.onProgress      — called with job state on every segment
 * @param {Function}      opts.onComplete      — called with final Blob
 * @param {Function}      opts.onError         — called with Error
 * @returns {string} jobId
 */
export function startSegmentDownload(opts) {
  const {
    jobId,
    segments,
    initSegment = null,
    outputExt = 'ts',
    keyFetcher,
    segmentFetcher,
    onProgress = () => {},
    onComplete = () => {},
    onError = () => {},
  } = opts;

  if (!keyFetcher || !segmentFetcher) {
    throw new Error('keyFetcher and segmentFetcher are required');
  }

  const controller = new AbortController();
  abortControllers.set(jobId, controller);

  const job = {
    id: jobId,
    state: 'running',
    totalSegments: segments.length,
    completedSegments: 0,
    totalBytes: 0,
    startTime: Date.now(),
    error: '',
    onProgress,
  };
  jobs.set(jobId, job);

  const buffers = new Array(segments.length);
  segmentBuffers.set(jobId, buffers);

  const keyCache = new Map();

  runPipeline(jobId, segments, buffers, initSegment, outputExt,
    keyFetcher, segmentFetcher, keyCache, controller, job, onComplete, onError);

  return jobId;
}

/**
 * Pause an active download. Completed segments are preserved.
 */
export function pauseDownload(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.state !== 'running') return;
  job.state = 'paused';
  abortControllers.get(jobId)?.abort();
  job.onProgress(job);
}

/**
 * Resume a paused download.
 */
export function resumeDownload(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.state !== 'paused') return;
  job.state = 'running';
  const controller = new AbortController();
  abortControllers.set(jobId, controller);
  job.onProgress(job);
}

/**
 * Cancel a download and free resources.
 */
export function cancelDownload(jobId) {
  abortControllers.get(jobId)?.abort();
  abortControllers.delete(jobId);
  segmentBuffers.delete(jobId);
  jobs.delete(jobId);
}

/**
 * Get the current state of a job.
 */
export function getJobState(jobId) {
  return jobs.get(jobId) || null;
}

/**
 * List all active/paused jobs.
 */
export function listJobs() {
  return Array.from(jobs.values());
}

// ── Download pipeline ───────────────────────────────────────────────

async function runPipeline(
  jobId, segments, buffers, initSegment, outputExt,
  keyFetcher, segmentFetcher, keyCache, controller, job, onComplete, onError,
) {
  try {
    await downloadAllSegments(segments, buffers, keyFetcher, segmentFetcher, keyCache, controller.signal, job);

    if (job.state === 'paused') return;

    // Assemble final blob
    const parts = [];
    if (initSegment) parts.push(initSegment);
    for (const buf of buffers) {
      if (buf) parts.push(buf);
    }

    const mimeType = outputExt === 'mp4' ? 'video/mp4' : 'video/mp2t';
    const blob = new Blob(parts, { type: mimeType });

    job.state = 'complete';
    job.onProgress(job);
    onComplete(blob);

    segmentBuffers.delete(jobId);
    abortControllers.delete(jobId);
  } catch (err) {
    if (err.name === 'AbortError' && job.state === 'paused') return;
    job.state = 'error';
    job.error = err.message;
    job.onProgress(job);
    onError(err);
  }
}

async function downloadAllSegments(segments, buffers, keyFetcher, segmentFetcher, keyCache, signal, job) {
  let cursor = 0;

  while (cursor < segments.length) {
    if (signal.aborted) throw new DOMException('Download paused', 'AbortError');

    const batch = [];
    while (batch.length < MAX_CONCURRENT && cursor < segments.length) {
      if (!buffers[cursor]) {
        batch.push({ index: cursor, spec: segments[cursor] });
      }
      cursor++;
    }

    if (batch.length === 0) continue;

    await Promise.all(
      batch.map(({ index, spec }) =>
        downloadOneSegment(index, spec, buffers, keyFetcher, segmentFetcher, keyCache, signal, job)
      )
    );
  }
}

async function downloadOneSegment(index, spec, buffers, keyFetcher, segmentFetcher, keyCache, signal, job) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal.aborted) throw new DOMException('Download paused', 'AbortError');

    try {
      // Fetch segment via strategy chain
      let data = await segmentFetcher(spec.url);

      // Decrypt if AES-128
      if (spec.key?.method === 'AES-128' && spec.key.uri) {
        const cryptoKey = await getOrFetchKey(spec.key.uri, keyFetcher, keyCache);
        const iv = spec.key.iv
          ? ivFromHex(spec.key.iv)
          : ivFromSequenceNumber(spec.sequence);
        data = await decryptSegment(data, cryptoKey, iv);
      }

      buffers[index] = data;
      job.completedSegments++;
      job.totalBytes += data.byteLength;
      job.onProgress(job);
      return;

    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastError = err;

      if (attempt < MAX_RETRIES) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        await sleep(delay, signal);
      }
    }
  }

  throw lastError || new Error(`Segment ${index} failed after ${MAX_RETRIES} retries`);
}

async function getOrFetchKey(keyUri, keyFetcher, keyCache) {
  if (keyCache.has(keyUri)) return keyCache.get(keyUri);

  const rawKey = await keyFetcher(keyUri);
  if (rawKey.byteLength !== 16) {
    throw new Error(`Expected 16-byte key, got ${rawKey.byteLength} bytes`);
  }
  const cryptoKey = await importAesKey(rawKey);
  keyCache.set(keyUri, cryptoKey);
  return cryptoKey;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}
