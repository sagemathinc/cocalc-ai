/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
Strict parsing of one OpenSSH ed25519 public key line, shared by the server
(a pod's reported host key, a launch's client key) and the CLI (what it
writes to known_hosts). Only the canonical "ssh-ed25519 <base64>" form ever
leaves this function; any comment is dropped.

The base64 must decode to the OpenSSH wire blob: exactly two length-prefixed
strings, "ssh-ed25519" and a 32-byte key, with nothing after them.
*/

import { createHash } from "crypto";

export const MAX_SSH_KEY_LINE = 200;

const TYPE = "ssh-ed25519";

export interface Ed25519PublicKey {
  // "ssh-ed25519 <canonical base64>", no comment
  line: string;
  // "SHA256:<unpadded base64>", as `ssh-keygen -lf` prints it
  fingerprint: string;
}

export function parseEd25519PublicKey(input: unknown): Ed25519PublicKey {
  if (typeof input !== "string") throw new Error("invalid ssh-ed25519 key");
  if (input.length > MAX_SSH_KEY_LINE || /[\0\r\n]/.test(input)) {
    throw new Error("invalid ssh-ed25519 key");
  }
  // "<type> <base64>" or "<type> <base64> <comment>" (one word, dropped)
  const words = input.trim().split(/[ \t]+/);
  if (words.length < 2 || words.length > 3 || words[0] !== TYPE) {
    throw new Error("invalid ssh-ed25519 key");
  }
  const b64 = words[1];
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) {
    throw new Error("invalid ssh-ed25519 key");
  }
  const blob = Buffer.from(b64, "base64");
  // Canonical base64 only: no ambiguous padding bits.
  if (blob.toString("base64") !== b64) {
    throw new Error("invalid ssh-ed25519 key");
  }
  let offset = 0;
  const field = (): Buffer => {
    if (offset + 4 > blob.length) throw new Error("invalid ssh-ed25519 key");
    const n = blob.readUInt32BE(offset);
    offset += 4;
    if (n > blob.length - offset) throw new Error("invalid ssh-ed25519 key");
    const value = blob.subarray(offset, offset + n);
    offset += n;
    return value;
  };
  const type = field();
  const key = field();
  if (
    type.toString("latin1") !== TYPE ||
    key.length !== 32 ||
    offset !== blob.length
  ) {
    throw new Error("invalid ssh-ed25519 key");
  }
  const digest = createHash("sha256").update(blob).digest("base64");
  return {
    line: `${TYPE} ${b64}`,
    fingerprint: `SHA256:${digest.replace(/=+$/, "")}`,
  };
}

export function isEd25519PublicKey(input: unknown): boolean {
  try {
    parseEd25519PublicKey(input);
    return true;
  } catch {
    return false;
  }
}
