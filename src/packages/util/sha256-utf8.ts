/*
SHA-256 of a string's UTF-8 encoding, computed incrementally: the string is
encoded and hashed in slices, so no second copy of a large value is ever
built, and hashing stops as soon as the encoding passes maxBytes.

Used for the proof that a saved file is exactly a document's value (bounded
history design, H1b), in browsers and in node, so it needs no node:crypto.
*/

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  private w = new Uint32Array(64);
  private block = new Uint8Array(64);
  private blockLength = 0;
  private bytes = 0;
  private done = false;

  update = (data: Uint8Array): this => {
    if (this.done) throw Error("sha256: already finished");
    let i = 0;
    this.bytes += data.length;
    if (this.blockLength > 0) {
      const n = Math.min(64 - this.blockLength, data.length);
      this.block.set(data.subarray(0, n), this.blockLength);
      this.blockLength += n;
      i = n;
      if (this.blockLength < 64) return this;
      this.compress(this.block, 0);
      this.blockLength = 0;
    }
    for (; i + 64 <= data.length; i += 64) {
      this.compress(data, i);
    }
    if (i < data.length) {
      this.block.set(data.subarray(i), 0);
      this.blockLength = data.length - i;
    }
    return this;
  };

  // lowercase hex
  digest = (): string => {
    if (this.done) throw Error("sha256: already finished");
    this.done = true;
    const bits = this.bytes * 8;
    const pad = new Uint8Array(this.blockLength < 56 ? 64 : 128);
    pad.set(this.block.subarray(0, this.blockLength));
    pad[this.blockLength] = 0x80;
    const view = new DataView(pad.buffer);
    view.setUint32(pad.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(pad.length - 4, bits >>> 0);
    for (let i = 0; i < pad.length; i += 64) this.compress(pad, i);
    let hex = "";
    for (const x of this.h) hex += x.toString(16).padStart(8, "0");
    return hex;
  };

  private compress = (data: Uint8Array, offset: number): void => {
    const w = this.w;
    for (let t = 0; t < 16; t++) {
      const j = offset + t * 4;
      w[t] =
        (data[j] << 24) |
        (data[j + 1] << 16) |
        (data[j + 2] << 8) |
        data[j + 3];
    }
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15];
      const y = w[t - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 =
        ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = this.h;
    for (let t = 0; t < 64; t++) {
      const S1 =
        ((e >>> 6) | (e << 26)) ^
        ((e >>> 11) | (e << 21)) ^
        ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + w[t]) | 0;
      const S0 =
        ((a >>> 2) | (a << 30)) ^
        ((a >>> 13) | (a << 19)) ^
        ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    this.h[0] += a;
    this.h[1] += b;
    this.h[2] += c;
    this.h[3] += d;
    this.h[4] += e;
    this.h[5] += f;
    this.h[6] += g;
    this.h[7] += h;
  };
}

// characters encoded per slice (at most 3 MiB of UTF-8)
const SLICE_CHARS = 1024 * 1024;

let encoder: TextEncoder | undefined;

// The SHA-256 (hex) and byte length of value's UTF-8 encoding, or undefined
// if that encoding is longer than maxBytes -- found out without encoding more
// than one slice past maxBytes.
export function sha256Utf8(
  value: string,
  { maxBytes = Infinity }: { maxBytes?: number } = {},
): { sha256: string; bytes: number } | undefined {
  // every character is at least one byte
  if (value.length > maxBytes) return undefined;
  encoder ??= new TextEncoder();
  const hash = new Sha256();
  let bytes = 0;
  for (let start = 0; start < value.length; ) {
    let end = Math.min(start + SLICE_CHARS, value.length);
    // never split a surrogate pair between slices: its halves would each
    // encode as U+FFFD
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) {
      end -= 1;
    }
    const encoded = encoder.encode(value.slice(start, end));
    bytes += encoded.length;
    if (bytes > maxBytes) return undefined;
    hash.update(encoded);
    start = end;
  }
  return { sha256: hash.digest(), bytes };
}
