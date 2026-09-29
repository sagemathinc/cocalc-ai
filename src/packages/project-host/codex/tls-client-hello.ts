/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

// Minimal TLS ClientHello reader for the restricted egress proxy: extract the
// server name (SNI) a client asks for inside a CONNECT tunnel, before any of
// its bytes are forwarded upstream. Anything unexpected is an error; callers
// must fail closed.

const RECORD_HEADER_BYTES = 5;
const HANDSHAKE_RECORD = 0x16;
const CLIENT_HELLO = 0x01;
const SERVER_NAME_EXTENSION = 0x0000;
const HOST_NAME = 0x00;

export type ClientHelloResult =
  // More bytes are needed.
  | { state: "incomplete" }
  | { state: "invalid"; reason: string }
  | { state: "complete"; serverName: string };

class Reader {
  offset = 0;
  constructor(private readonly bytes: Buffer) {}
  private need(n: number) {
    if (this.offset + n > this.bytes.length) throw Error("truncated");
  }
  u8(): number {
    this.need(1);
    return this.bytes[this.offset++];
  }
  u16(): number {
    this.need(2);
    const value = this.bytes.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }
  u24(): number {
    this.need(3);
    const value = this.bytes.readUIntBE(this.offset, 3);
    this.offset += 3;
    return value;
  }
  take(n: number): Buffer {
    this.need(n);
    const value = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return value;
  }
  get remaining(): number {
    return this.bytes.length - this.offset;
  }
}

/**
 * Parse the start of a client TLS stream. The ClientHello may span several
 * handshake records; `data` is everything received so far.
 */
export function readClientHelloServerName(data: Buffer): ClientHelloResult {
  // Reassemble the handshake payload from consecutive handshake records.
  const payloads: Buffer[] = [];
  let payloadBytes = 0;
  let offset = 0;
  let handshakeLength: number | undefined;
  while (true) {
    if (data.length - offset < RECORD_HEADER_BYTES)
      return { state: "incomplete" };
    if (data[offset] !== HANDSHAKE_RECORD)
      return { state: "invalid", reason: "not a TLS handshake record" };
    if (data[offset + 1] !== 0x03)
      return { state: "invalid", reason: "unsupported TLS record version" };
    const length = data.readUInt16BE(offset + 3);
    if (length === 0) return { state: "invalid", reason: "empty TLS record" };
    if (data.length - offset - RECORD_HEADER_BYTES < length)
      return { state: "incomplete" };
    payloads.push(
      data.subarray(
        offset + RECORD_HEADER_BYTES,
        offset + RECORD_HEADER_BYTES + length,
      ),
    );
    payloadBytes += length;
    offset += RECORD_HEADER_BYTES + length;
    if (handshakeLength == null && payloadBytes >= 4) {
      const header = Buffer.concat(payloads);
      if (header[0] !== CLIENT_HELLO)
        return {
          state: "invalid",
          reason: "first handshake is not ClientHello",
        };
      handshakeLength = header.readUIntBE(1, 3);
    }
    if (handshakeLength != null && payloadBytes >= 4 + handshakeLength) break;
  }
  const hello = Buffer.concat(payloads).subarray(4, 4 + handshakeLength);
  try {
    const reader = new Reader(hello);
    reader.u16(); // legacy_version
    reader.take(32); // random
    reader.take(reader.u8()); // legacy_session_id
    reader.take(reader.u16()); // cipher_suites
    reader.take(reader.u8()); // legacy_compression_methods
    if (reader.remaining === 0)
      return { state: "invalid", reason: "ClientHello has no extensions" };
    const extensions = new Reader(reader.take(reader.u16()));
    if (reader.remaining !== 0)
      return { state: "invalid", reason: "trailing bytes after extensions" };
    let serverName: string | undefined;
    while (extensions.remaining > 0) {
      const type = extensions.u16();
      const body = new Reader(extensions.take(extensions.u16()));
      if (type !== SERVER_NAME_EXTENSION) continue;
      if (serverName != null)
        return { state: "invalid", reason: "duplicate server_name extension" };
      const list = new Reader(body.take(body.u16()));
      if (body.remaining !== 0)
        return { state: "invalid", reason: "trailing bytes after server_name" };
      const names: string[] = [];
      while (list.remaining > 0) {
        const nameType = list.u8();
        const name = list.take(list.u16());
        if (nameType !== HOST_NAME) continue;
        // Compare exact bytes: "ascii" decoding would mask high bits and
        // alias e.g. 0xe3 "hatgpt.com" to "chatgpt.com".
        if (name.some((byte) => byte > 0x7f))
          return { state: "invalid", reason: "non-ASCII server name" };
        names.push(name.toString("latin1"));
      }
      if (names.length !== 1)
        return { state: "invalid", reason: "expected exactly one host name" };
      serverName = names[0];
    }
    if (!serverName) return { state: "invalid", reason: "no server name" };
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(serverName))
      return { state: "invalid", reason: "malformed server name" };
    return {
      state: "complete",
      serverName: serverName.toLowerCase().replace(/\.$/, ""),
    };
  } catch {
    return { state: "invalid", reason: "malformed ClientHello" };
  }
}
