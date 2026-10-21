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
import { legacyPatchId } from "patchflow";
import { Sha256 } from "@cocalc/util/sha256-utf8";
import { type FileProof, readFileProof } from "./file-proof";
import { isJupyterPath } from "@cocalc/util/jupyter/names";
import { isBoardSyncdbPath } from "@cocalc/util/board/names";

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
    // ignoreBOM: keep a leading byte order mark in the value, as it is in
    // the bytes the proof hashes; otherwise the seed would silently differ
    // from the file
    value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      data,
    );
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

// Whether this document's file is written by SyncDoc.writeFile, so its
// saved file can carry a proof (file-proof.ts).  This is a property of the
// document, not of the client that opened it: clients that never write the
// file (noSaveToDisk, e.g., agents and the sync-fs service) open the same
// documents.  The exceptions are documents whose file is written elsewhere,
// in another format: a notebook's syncdb (its .ipynb) and a board's.
export function savesThroughWriteFile(syncPath: string): boolean {
  return !isJupyterPath(syncPath) && !isBoardSyncdbPath(syncPath);
}

// How the user can restart an unloadable history: from the saved file (with
// its proof, H1b-1b), from a notebook's saved .ipynb (H1b-3b, through the
// project), or not at all (a board, until the board work).
export type HistoryRestartKind = "file" | "ipynb" | "none";

export function historyRestartKind(syncPath: string): HistoryRestartKind {
  if (savesThroughWriteFile(syncPath)) return "file";
  if (isJupyterPath(syncPath)) return "ipynb";
  return "none";
}

// While a document's open keeps retrying, read the saved file again only
// for a proof not already found not to match it.  Only the last rejected
// proof is remembered: enough not to reread an unchanged one, and bounded
// however often the file or proof changes.
export class ProofReads {
  private rejected?: string;

  static key = (state: HistoryResetState): string =>
    `${state.epoch}:${state.seq}:${state.proof?.data?.sha256}`;

  shouldRead = (state: HistoryResetState): boolean =>
    this.rejected !== ProofReads.key(state);

  reject = (state: HistoryResetState): void => {
    this.rejected = ProofReads.key(state);
  };

  // for tests
  retained = (): number => (this.rejected == null ? 0 : 1);
}

export const LATEST_SNAPSHOT_CHECKPOINT = "latest_snapshot";

// The first message of the new history: a snapshot of value, as SyncDoc's
// patches are stored (see SyncDoc.snapshot), with its checkpoint.
// The first message of a restarted history: a snapshot of value (a string
// document's text, or a db document's JSON lines), by the filesystem user (the
// first user of a document), now.
export function seedOfValue(value: string) {
  const now = Date.now();
  return seedFor({ value, time: legacyPatchId(now), wall: now, userId: 0 });
}

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
