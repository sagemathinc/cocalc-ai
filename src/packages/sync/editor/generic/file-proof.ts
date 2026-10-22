/*
The proof that a saved file is a document's value at a known point of its
history (bounded history design, H1b): the saver records which seq its value
covered and the hash of the exact bytes it wrote.  A client that later has to
restart the history from the file uses it only if the file's bytes still
match.
*/

import { sha256Utf8 } from "@cocalc/util/sha256-utf8";

// the persist checkpoint holding the proof; never an archive cut
export const SAVED_FILE_CHECKPOINT = "saved_file";

// No proof for a larger value (the document size limit, in UTF-8 bytes).
export const FILE_PROOF_MAX_BYTES = 32 * 1024 * 1024;

export interface FileProof {
  // the history epoch the value belongs to
  epoch: number;
  // the value includes every message with seq at most this
  seq: number;
  // of the UTF-8 bytes written
  sha256: string;
  bytes: number;
}

// The proof for value, or undefined if it is too large to prove.  The caller
// must capture value, epoch and seq together, with no await in between.
export function fileProof({
  value,
  epoch,
  seq,
}: {
  value: string;
  epoch: number;
  seq: number;
}): FileProof | undefined {
  const hashed = sha256Utf8(value, { maxBytes: FILE_PROOF_MAX_BYTES });
  if (hashed == null) return undefined;
  return { epoch, seq, ...hashed };
}

// The proof as stored in the checkpoint, or undefined if it is not a valid
// one.
export function readFileProof(checkpoint?: {
  seq?: number;
  data?: any;
}): FileProof | undefined {
  const { seq, data } = checkpoint ?? {};
  if (
    !Number.isSafeInteger(seq) ||
    data == null ||
    typeof data.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(data.sha256) ||
    !Number.isSafeInteger(data.bytes) ||
    !Number.isSafeInteger(data.epoch)
  ) {
    return undefined;
  }
  return {
    epoch: data.epoch,
    seq: seq!,
    sha256: data.sha256,
    bytes: data.bytes,
  };
}
