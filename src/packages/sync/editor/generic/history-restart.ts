/*
Restarting a document's history from its saved file, when the history holds
an entry too large to load (bounded history plan r3, §2.2-§2.3).  These are
the decisions, kept apart from SyncDoc so they can be tested on their own:

- the saved file is used only if it decodes as UTF-8 and is at most
  FILE_PROOF_MAX_BYTES (the reader never returns more);
- its proof is valid only for the current epoch and the exact bytes read;
- the seed is a snapshot of the file's value;
- the reset is conditional on the state that was judged, and its opId is
  derived from all of its inputs, so a retry with the same inputs gets the
  first result and anything changed is a new reset with new checks.
*/

import { DataEncoding, encode } from "@cocalc/conat/core/codec";
import { Sha256 } from "@cocalc/util/sha256-utf8";
import { type FileProof, readFileProof } from "./file-proof";

// What the reset judges: the history's newest seq and message count, its
// epoch, and the saved file proof checkpoint, if any.
export interface HistoryResetState {
  seq: number;
  count: number;
  epoch: number;
  proof?: { seq?: number; data?: any };
}

// a bounded read of the saved file
export type SavedFileRead =
  | { status: "ok"; data: Uint8Array }
  | { status: "missing" | "too-large" | "unavailable"; error?: string };

export interface SavedFile {
  value: string;
  sha256: string;
  bytes: number;
}

// The file's value and the hash of exactly these bytes, or undefined if they
// are not UTF-8 text.
export function savedFileOf(data: Uint8Array): SavedFile | undefined {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
  return {
    value,
    sha256: new Sha256().update(data).digest(),
    bytes: data.length,
  };
}

// The proof, if it is valid for these exact bytes in this state.
export function validProof(
  state: HistoryResetState,
  file: SavedFile,
): FileProof | undefined {
  const proof = readFileProof(state.proof);
  if (
    proof == null ||
    proof.epoch !== state.epoch ||
    proof.sha256 !== file.sha256 ||
    proof.bytes !== file.bytes ||
    proof.seq > state.seq
  ) {
    return undefined;
  }
  return proof;
}

// Case 1: the proof covers every accepted message.
export function proofCoversHistory(state: HistoryResetState): boolean {
  const proof = readFileProof(state.proof);
  return (
    proof != null && proof.epoch === state.epoch && proof.seq === state.seq
  );
}

export const LATEST_SNAPSHOT_CHECKPOINT = "latest_snapshot";

// The first message of the new history: a snapshot of value, as SyncDoc's
// patches are stored (see SyncDoc.snapshot), with its checkpoint.
export function seedFor({
  value,
  time,
  wall,
  userId,
}: {
  value: string;
  time: string;
  wall: number;
  userId: number;
}) {
  const patch = {
    time,
    wall,
    is_snapshot: true,
    snapshot: value,
    size: value.length,
    user_id: userId,
    // the new history starts here: nothing older to load
    seq_info: { seq: 0 },
  };
  return {
    encoding: DataEncoding.MsgPack,
    raw: encode({ encoding: DataEncoding.MsgPack, mesg: patch }),
    checkpoint: {
      name: LATEST_SNAPSHOT_CHECKPOINT,
      data: { patchId: time },
    },
  };
}

export type RestartMode =
  // automatic, at open: only when the proof covers the whole history
  | "oversized"
  // the user's explicit restart: a rollback to what the file covers
  | "user-restart-from-file";

export function resetOptions({
  mode,
  state,
  file,
  proof,
  seed,
  now = Date.now(),
}: {
  mode: RestartMode;
  state: HistoryResetState;
  file: SavedFile;
  proof?: FileProof;
  seed: ReturnType<typeof seedFor>;
  now?: number;
}) {
  if (mode == "oversized" && (proof == null || proof.seq !== state.seq)) {
    throw Error("bug: an automatic reset needs a proof covering the history");
  }
  // without a valid proof, the file is known to cover nothing
  const coveredSeq = proof != null ? proof.seq : 0;
  const coverage = proof != null ? "proven" : "none";
  return {
    ifRevision: { seq: state.seq, count: state.count },
    ifInitEpoch: state.epoch,
    coveredSeq,
    allowRollback: mode == "user-restart-from-file",
    archive: true,
    seed,
    reason: mode,
    opId: [
      mode,
      state.epoch,
      state.seq,
      state.count,
      proof?.seq ?? "none",
      file.sha256,
    ].join(":"),
    settings: {
      // open copies of the document close on this, as for a purge
      history_purged_at: now,
      history_reset: { reason: mode, coverage, coveredSeq, time: now },
    },
  };
}
