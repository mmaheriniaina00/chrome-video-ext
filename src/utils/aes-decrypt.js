/**
 * AES-128-CBC decryption via the Web Crypto API.
 *
 * Used to decrypt HLS segments that carry #EXT-X-KEY METHOD=AES-128.
 * The key is a 16-byte value fetched from the URI in the EXT-X-KEY tag.
 * The IV is either specified explicitly or derived from the segment
 * sequence number.
 */

/**
 * Import a raw 16-byte AES key for use with Web Crypto.
 *
 * @param {ArrayBuffer} rawKey — 16 bytes
 * @returns {Promise<CryptoKey>}
 */
export async function importAesKey(rawKey) {
  return crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-CBC' },
    false,
    ['decrypt'],
  );
}

/**
 * Decrypt an AES-128-CBC encrypted segment.
 *
 * @param {ArrayBuffer} encryptedData — the ciphertext (full segment bytes)
 * @param {CryptoKey}   key           — imported AES key
 * @param {ArrayBuffer} iv            — 16-byte initialization vector
 * @returns {Promise<ArrayBuffer>}    — decrypted plaintext
 */
export async function decryptSegment(encryptedData, key, iv) {
  return crypto.subtle.decrypt(
    { name: 'AES-CBC', iv },
    key,
    encryptedData,
  );
}

/**
 * Derive the IV from a segment's media sequence number (HLS default).
 *
 * When no explicit IV is given in #EXT-X-KEY, the IV is the segment's
 * media sequence number expressed as a big-endian 128-bit integer.
 *
 * @param {number} sequenceNumber
 * @returns {ArrayBuffer} — 16 bytes
 */
export function ivFromSequenceNumber(sequenceNumber) {
  const iv = new ArrayBuffer(16);
  const view = new DataView(iv);
  // Place the sequence number in the last 4 bytes (big-endian)
  view.setUint32(12, sequenceNumber, false);
  return iv;
}

/**
 * Parse a hex IV string (0x...) into an ArrayBuffer.
 *
 * @param {string} hexStr — e.g. "0x00000000000000000000000000000001"
 * @returns {ArrayBuffer} — 16 bytes
 */
export function ivFromHex(hexStr) {
  const hex = hexStr.replace(/^0x/i, '');
  if (hex.length !== 32) {
    throw new Error(`Invalid IV hex length: expected 32 chars, got ${hex.length}`);
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

/**
 * Fetch an AES-128 key from a URI, optionally with auth headers.
 *
 * @param {string}      keyUri
 * @param {HeadersInit} [headers={}]
 * @returns {Promise<ArrayBuffer>} — the raw 16-byte key
 */
export async function fetchKey(keyUri, headers = {}) {
  const res = await fetch(keyUri, {
    headers,
    credentials: 'include',
  });

  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? ' (authentication required — session may have expired)'
      : '';
    throw new Error(`Key fetch failed: ${res.status}${hint}`);
  }

  const buf = await res.arrayBuffer();
  if (buf.byteLength !== 16) {
    throw new Error(`Expected 16-byte key, got ${buf.byteLength} bytes`);
  }

  return buf;
}
