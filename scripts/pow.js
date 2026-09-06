/**
 * Proof-of-Work для регистрации (hashcash, в духе старого интернета).
 *
 * Браузер ищет nonce такой, что sha256(prefix:nonce) имеет
 * не меньше `difficulty` ведущих нулевых бит. Для человека это
 * доли секунды, для ботоферм — реальная стоимость за каждую учетку.
 *
 * Использует Web Crypto (subtle.digest); там, где он недоступен
 * (страница по http, не https/localhost), работает встроенный JS-фолбэк.
 */

'use strict';

// ---------- Минимальная JS-реализация sha256 (фолбэк) ----------

const sha256Bytes = (() => {
  function rr(x, n) { return (x >>> n) | (x << (32 - n)); }

  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  return function (bytes) {
    const H = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);

    const len = bytes.length;
    const bitLenHi = Math.floor(len / 0x20000000);
    const bitLenLo = (len << 3) >>> 0;
    const padded = new Uint8Array((((len + 8) >> 6) << 6) + 64);
    padded.set(bytes);
    padded[len] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, bitLenHi);
    dv.setUint32(padded.length - 4, bitLenLo);

    const w = new Uint32Array(64);
    for (let i = 0; i < padded.length; i += 64) {
      for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4);
      for (let j = 16; j < 64; j++) {
        const s0 = rr(w[j - 15], 7) ^ rr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
        const s1 = rr(w[j - 2], 17) ^ rr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
        w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
      }
      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let j = 0; j < 64; j++) {
        const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[j] + w[j]) >>> 0;
        const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
        const mj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + mj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
      H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
      H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }

    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
    return out;
  };
})();

function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** sha256 строки -> hex (Web Crypto с фолбэком на JS-реализацию) */
async function sha256Hex(str) {
  if (window.crypto && window.crypto.subtle && window.isSecureContext) {
    const buf = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return bytesToHex(new Uint8Array(buf));
  }
  return bytesToHex(sha256Bytes(new TextEncoder().encode(str)));
}

/** Ведущие нулевые биты hex-строки */
function leadingZeroBits(hex) {
  let bits = 0;
  for (const c of hex) {
    const v = parseInt(c, 16);
    if (v === 0) { bits += 4; continue; }
    if (v < 2) bits += 3; else if (v < 4) bits += 2; else if (v < 8) bits += 1;
    break;
  }
  return bits;
}

/**
 * Решить челлендж: ищем nonce, при котором sha256(prefix:nonce)
 * имеет >= difficulty ведущих нулевых бит.
 *
 * @returns {Promise<{nonce:number, hash:string, ms:number}>}
 */
async function solveChallenge(prefix, difficulty, onProgress) {
  const started = performance.now();
  let nonce = 0;
  let hash = '';
  const BATCH = 4000; // пачками, чтобы не замораживать вкладку

  for (;;) {
    for (let i = 0; i < BATCH; i++) {
      hash = await sha256Hex(`${prefix}:${nonce}`);
      if (leadingZeroBits(hash) >= difficulty) {
        return { nonce, hash, ms: Math.round(performance.now() - started) };
      }
      nonce++;
    }
    if (onProgress) onProgress(nonce, Math.round(performance.now() - started));
    await new Promise((r) => setTimeout(r, 0)); // отдаем управление браузеру
  }
}

window.CabanPow = { solveChallenge, sha256Hex, leadingZeroBits };