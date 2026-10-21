/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Restarting a notebook's edit history from its saved .ipynb, after the user
confirmed it (bounded history plan H1b-3 r4, §3, option B).

The history of the notebook's syncdb holds an entry too large to load, and no
live writer could seed a new history from the open notebook (option A, H1b-3c).
The user saw the history's state (epoch and revision) and confirmed restarting
from the saved notebook.  This builds the new history's first value offline,
from the .ipynb, and resets the history in ONE seeded reset, conditional on
exactly what the user confirmed:

- nothing is ever written to the live syncdb (which may not even load); the
  seed is installed by the persist server's reset itself, atomically, so no
  later import can land on top of live edits;
- the reset is fenced on the confirmed epoch and revision: anything accepted
  since (an edit, a settings change) refuses it ("moved"), and the user is
  asked again;
- its opId is derived from the confirmed state and the file's bytes, so a
  retry of the same request gets the first result back.

Bounds (LIMIT-H1B3P-2, -3): one run per document at a time, taken before any
read or build; one overall deadline; at most one unresolved reset per
document (the gate, cleared only by its own answer or by an observation of
the history); and the import is capped as it goes, before anything is added.
*/

import { join } from "node:path";
import { createHash } from "node:crypto";
import { akv } from "@cocalc/conat/sync/akv";
import { SyncClient } from "@cocalc/conat/sync-doc/sync-client";
import type { ResetHistoryResult } from "@cocalc/conat/persist/storage";
import type { SeedOversizedHistoryResult } from "@cocalc/conat/project/api/jupyter";
import { RESET_BUSY_DELAY_MS } from "@cocalc/conat/persist/reset-busy";
import { seedOfValue } from "@cocalc/sync/editor/generic/history-restart";
import {
  DeadlineExpired,
  gateAllowsReset as sharedGateAllowsReset,
  isNonnegativeSafeInteger,
  resetRunState,
  resolveGate,
  runInProgress,
  setUnresolvedReset,
  startRun,
  unresolvedReset,
  utf8Bytes,
  withDeadline,
} from "@cocalc/sync/editor/generic/reset-run";
import { jsonMeasureCapped } from "@cocalc/util/json-size";
import { ipynbPath, syncdbPath } from "@cocalc/util/jupyter/names";
import { IPynbImporter } from "@cocalc/jupyter/ipynb/import-from-ipynb";
import { blobifyOutputData } from "@cocalc/jupyter/util/blobify-output";
import { patchCellMetadataWithLastRuntime } from "@cocalc/jupyter/redux/actions";
import { prepareIpynbAttachments } from "@cocalc/jupyter/redux/project-actions";
import { getLogger } from "@cocalc/backend/logger";

const logger = getLogger("jupyter:history-restart");

export const RESTART_LIMITS = {
  // the whole run, from receipt (§3 step 0)
  deadlineMs: 40_000,
  fileBytes: 32 * 1024 * 1024,
  cells: 10_000,
  attachments: 1_000,
  attachmentBytes: 32 * 1024 * 1024,
  valueBytes: 32 * 1024 * 1024,
  // the work cap of the value measurement (LIMIT-H1B2I-2), shared by every
  // record
  valueWork: 32 * 1024 * 1024,
  seedBytes: 40 * 1024 * 1024,
  pathBytes: 4096,
  // how often a request may re-observe the history while a reset is unresolved
  gateObserveMs: 10_000,
};

export type RestartRefusal =
  | "invalid"
  | "busy"
  | "deadline"
  | "too-large"
  | "missing"
  | "unreadable"
  | "moved"
  | "epoch"
  | "failed";

export type RestartResult =
  | { restarted: true; history_epoch: number; repeated?: boolean }
  | { restarted: false; reason: RestartRefusal; message?: string };

// ---------------------------------------------------------------------------
// One run per document, and at most one unresolved reset per document: the
// shared bounds of sync/editor/generic/reset-run.ts (also the board rebuild).

export { runInProgress, unresolvedReset };

// for tests
export function resetHistoryRestartState() {
  resetRunState();
}

// ---------------------------------------------------------------------------
// Validation

export function validRestartRequest(opts: any): string | undefined {
  const path = opts?.path;
  if (
    typeof path !== "string" ||
    path.length == 0 ||
    utf8Bytes(path) > RESTART_LIMITS.pathBytes
  ) {
    return `path must be a string of at most ${RESTART_LIMITS.pathBytes} UTF-8 bytes`;
  }
  if (!isNonnegativeSafeInteger(opts?.epoch)) {
    return "epoch must be a nonnegative safe integer";
  }
  const revision = opts?.revision;
  if (
    !isNonnegativeSafeInteger(revision?.seq) ||
    !isNonnegativeSafeInteger(revision?.count)
  ) {
    return "revision must be {seq, count} of nonnegative safe integers";
  }
}

// ---------------------------------------------------------------------------
// The capped offline import (§3 step 2)

class TooLarge extends Error {
  constructor(public what: string) {
    super(`the saved notebook is too large to restart from (${what})`);
  }
}

// The cells, and the attachments they hold, counted before anything is built.
function checkIpynbCounts(ipynb: any) {
  const cells: any[] = [];
  if (Array.isArray(ipynb?.cells)) cells.push(...ipynb.cells);
  // nbformat < 4: cells are in worksheets
  for (const sheet of Array.isArray(ipynb?.worksheets)
    ? ipynb.worksheets
    : []) {
    if (Array.isArray(sheet?.cells)) cells.push(...sheet.cells);
    if (cells.length > RESTART_LIMITS.cells) break;
  }
  if (cells.length > RESTART_LIMITS.cells) {
    throw new TooLarge(`more than ${RESTART_LIMITS.cells} cells`);
  }
  let attachments = 0;
  for (const cell of cells) {
    const a = cell?.attachments;
    if (a == null || typeof a !== "object") continue;
    for (const _ in a) {
      attachments += 1;
      if (attachments > RESTART_LIMITS.attachments) {
        throw new TooLarge(
          `more than ${RESTART_LIMITS.attachments} attachments`,
        );
      }
    }
  }
}

// The syncdb records of a notebook imported from ipynb, as JSON lines (what
// the syncdb's to_str() writes), without a live syncdb.  Outputs' images, PDFs
// and isolated HTML go to the notebook's blob store, as for any import; they
// count against the attachment budget.  Every record is measured against what
// remains of the value's byte and work budgets before it is added.
export async function ipynbSeedValue({
  ipynb,
  saveBlob,
  deadlineAt,
}: {
  ipynb: any;
  saveBlob: (sha1: string, bytes: Buffer) => Promise<void>;
  deadlineAt: number;
}): Promise<string> {
  checkIpynbCounts(ipynb);
  let blobs = 0;
  let blobBytes = 0;
  const writes: Promise<void>[] = [];
  const importer = new IPynbImporter();
  let n = 0;
  const used = new Set<string>();
  const new_id = (is_available?: (id: string) => boolean) => {
    for (;;) {
      const id = (n++).toString(36).padStart(6, "0");
      if (!used.has(id) && (is_available == null || is_available(id))) {
        used.add(id);
        return id;
      }
    }
  };
  importer.import({
    ipynb,
    new_id,
    cellOutputHandler: (cell) => ({
      message: (content, k) => {
        if (content?.data != null) {
          blobifyOutputData(content.data, (bytes, sha1) => {
            blobs += 1;
            blobBytes += bytes.length;
            if (
              blobs > RESTART_LIMITS.attachments ||
              blobBytes > RESTART_LIMITS.attachmentBytes
            ) {
              throw new TooLarge(
                `more than ${RESTART_LIMITS.attachments} output files or ${RESTART_LIMITS.attachmentBytes} bytes of them`,
              );
            }
            writes.push(saveBlob(sha1, bytes));
            return sha1;
          });
        }
        cell.output[k] = content;
      },
    }),
  });

  const lines: string[] = [];
  let bytes = 0;
  let work = 0;
  const add = (record: object) => {
    const remaining =
      RESTART_LIMITS.valueBytes - bytes - (lines.length > 0 ? 1 : 0);
    const measured = jsonMeasureCapped(record, {
      max: remaining,
      maxWork: RESTART_LIMITS.valueWork - work,
    });
    if (measured == null) {
      throw new TooLarge(`more than ${RESTART_LIMITS.valueBytes} bytes`);
    }
    work += measured.work;
    bytes += measured.bytes + (lines.length > 0 ? 1 : 0);
    lines.push(JSON.stringify(record));
  };
  try {
    const cells = importer.cells() ?? {};
    for (const id in cells) {
      let cell = cells[id];
      if (Object.prototype.hasOwnProperty.call(cell, "last")) {
        cell = { ...cell };
        cell.metadata = patchCellMetadataWithLastRuntime(
          cell.metadata,
          cell.last,
        );
        delete cell.last;
      }
      add(cell);
    }
    const settings: any = { type: "settings", kernel: importer.kernel() };
    const metadata = importer.metadata();
    if (metadata != null) settings.metadata = metadata;
    add(settings);
  } finally {
    importer.close();
  }
  // every output file is stored before the history refers to it
  await withDeadline(deadlineAt, Promise.all(writes));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The restart

export async function restartHistoryFromIpynb({
  project_id,
  path,
  epoch,
  revision,
  client,
  fs,
  syncClient = new SyncClient(client),
  now = Date.now,
  blobStoreOf = (name) =>
    akv({
      name,
      project_id,
      client,
      config: { max_bytes: 100 * 1e6 },
    } as any),
}: {
  project_id: string;
  // the notebook: its .ipynb or its syncdb path
  path: string;
  // what the user confirmed
  epoch: number;
  revision: { seq: number; count: number };
  client: any;
  fs: any;
  // for tests
  syncClient?: Pick<
    SyncClient,
    "historyResetState" | "readFileBounded" | "resetHistory"
  >;
  now?: () => number;
  // for tests: the notebook's output blob store
  blobStoreOf?: (name: string) => {
    set: (key: string, value: Buffer) => Promise<unknown>;
    close?: () => void;
  };
}): Promise<RestartResult> {
  const invalid = validRestartRequest({ path, epoch, revision });
  if (invalid) return { restarted: false, reason: "invalid", message: invalid };
  const ipynb_path = ipynbPath(path);
  const syncPath = syncdbPath(ipynb_path);

  // §3 step 0: the document's run slot, and the gate, before any work.  The
  // deadline only ends the caller's wait: the slot is released when every
  // operation this run started has settled (LIMIT-H1B3B-1).
  const run = startRun(syncPath, {
    deadlineMs: RESTART_LIMITS.deadlineMs,
    now,
  });
  if (run == null) return { restarted: false, reason: "busy" };
  const { deadlineAt, track } = run;
  let blobStore: { close?: () => void } | undefined;
  try {
    if (
      !(await gateAllowsReset({
        syncPath,
        project_id,
        syncClient,
        deadlineAt,
        now,
        track,
      }))
    ) {
      return {
        restarted: false,
        reason: "busy",
        message: "a restart of this notebook's history is already in progress",
      };
    }

    // §3 step 1: the saved notebook, read with a bound
    const read = await withDeadline(
      deadlineAt,
      track(
        syncClient.readFileBounded({
          project_id,
          path: ipynb_path,
          maxBytes: RESTART_LIMITS.fileBytes,
        }),
      ),
    );
    if (read.status == "too-large") {
      return {
        restarted: false,
        reason: "too-large",
        message: "the saved notebook is larger than 32 MiB",
      };
    }
    if (read.status == "missing") {
      return {
        restarted: false,
        reason: "missing",
        message: `${ipynb_path} does not exist`,
      };
    }
    if (read.status != "ok") {
      return { restarted: false, reason: "unreadable", message: read.error };
    }
    const fileSha256 = createHash("sha256").update(read.data).digest("hex");
    let parsed: any;
    try {
      parsed = JSON.parse(Buffer.from(read.data).toString("utf8"));
    } catch (err) {
      return {
        restarted: false,
        reason: "unreadable",
        message: `the saved notebook is not valid JSON: ${err}`,
      };
    }

    // §3 step 2: the value, built offline, capped as it goes
    let value: string;
    try {
      checkIpynbCounts(parsed);
      const prepared = await withDeadline(
        deadlineAt,
        track(
          prepareIpynbAttachments({ ipynb: parsed, fs, client, project_id }),
        ),
      );
      const store = blobStoreOf(join("jupyter", ipynb_path));
      blobStore = store;
      value = await ipynbSeedValue({
        ipynb: prepared,
        deadlineAt,
        saveBlob: async (sha1, bytes) => {
          await track(store.set(sha1, bytes));
        },
      });
    } catch (err) {
      if (err instanceof TooLarge) {
        return { restarted: false, reason: "too-large", message: err.message };
      }
      throw err;
    }

    // §3 step 3: the seed's envelope, before anything is sent
    const seed = seedOfValue(value);
    if (seed.raw.length > RESTART_LIMITS.seedBytes) {
      return {
        restarted: false,
        reason: "too-large",
        message:
          "the restarted history's first entry would be larger than 40 MiB",
      };
    }

    // §3 step 4: one seeded reset, conditional on what the user confirmed
    const opId = [
      "ipynb-restart",
      epoch,
      revision.seq,
      revision.count,
      fileSha256,
    ].join(":");
    const time = now();
    const remaining = deadlineAt - now();
    if (remaining <= 0) throw new DeadlineExpired();
    if (
      !setUnresolvedReset(syncPath, {
        opId,
        epoch,
        revision,
        observedAt: now(),
      })
    ) {
      return { restarted: false, reason: "busy" };
    }
    const reset = syncClient.resetHistory({
      project_id,
      path: syncPath,
      // retry another reset's busy only for what remains of the deadline
      busyAttempts: Math.max(
        1,
        Math.floor(remaining / RESET_BUSY_DELAY_MS) - 1,
      ),
      options: {
        ifRevision: revision,
        ifInitEpoch: epoch,
        coveredSeq: 0,
        allowRollback: true,
        archive: true,
        seed,
        reason: "user-restart-ipynb",
        opId,
        settings: {
          history_purged_at: time,
          history_reset: {
            reason: "user-restart-ipynb",
            coverage: "none",
            coveredSeq: 0,
            time,
          },
        },
      } as any,
    });
    track(reset);
    // only this reset's own answer clears the gate, whenever it comes
    reset.then(
      () => resolveGate(syncPath, opId),
      () => resolveGate(syncPath, opId),
    );
    const result: ResetHistoryResult = await withDeadline(deadlineAt, reset);
    if (result.reset) {
      return {
        restarted: true,
        history_epoch: result.history_epoch,
        ...(result.repeated ? { repeated: true } : {}),
      };
    }
    const reason =
      result.refused == "moved" || result.refused == "epoch"
        ? result.refused
        : result.refused == "busy"
          ? "busy"
          : result.refused == "seed-too-large"
            ? "too-large"
            : "failed";
    return { restarted: false, reason, message: result.refused };
  } catch (err) {
    if (err instanceof DeadlineExpired) {
      return {
        restarted: false,
        reason: "deadline",
        message: "the restart took too long; try again",
      };
    }
    logger.debug("restartHistoryFromIpynb failed", { path, err: `${err}` });
    return { restarted: false, reason: "failed", message: `${err}` };
  } finally {
    // the slot (and the blob store) only when nothing of this run is left
    run.finish(() => blobStore?.close?.());
  }
}

// While a reset is unresolved, no other one is sent (LIMIT-H1B3P-2); see
// reset-run.ts.
async function gateAllowsReset({
  syncPath,
  project_id,
  syncClient,
  deadlineAt,
  now,
  track = (p) => p,
}: {
  syncPath: string;
  project_id: string;
  syncClient: Pick<SyncClient, "historyResetState">;
  deadlineAt: number;
  now: () => number;
  track?: <T>(p: Promise<T>) => Promise<T>;
}): Promise<boolean> {
  return await sharedGateAllowsReset({
    key: syncPath,
    readState: () =>
      syncClient.historyResetState({ project_id, path: syncPath }),
    deadlineAt,
    observeMs: RESTART_LIMITS.gateObserveMs,
    now,
    track,
  });
}

// ---------------------------------------------------------------------------
// (A) The live-writer seed (bounded history plan H1b-3 r4, §2): the project's
// backend seeds a new history from its live value, when its syncdb is ready
// in the epoch asked about.  Shares the run slot and the gate with (B).

interface SyncDocLike {
  isReady: () => boolean;
  seedHistoryFromLiveValue?: (opts: {
    epoch: number;
    deadlineAt: number;
    gate?: {
      beforeReset: (reset: {
        opId: string;
        epoch: number;
        revision: { seq: number; count: number };
      }) => boolean;
      answered: (opId: string) => void;
    };
    limits?: { stepMs?: number; reserveMs?: number; valueBytes?: number };
    track?: <T>(p: Promise<T>) => Promise<T>;
  }) => Promise<SeedOversizedHistoryResult>;
}

export function validSeedRequest(opts: any): string | undefined {
  const path = opts?.path;
  if (
    typeof path !== "string" ||
    path.length == 0 ||
    Buffer.byteLength(path, "utf8") > RESTART_LIMITS.pathBytes
  ) {
    return `path must be a string of at most ${RESTART_LIMITS.pathBytes} UTF-8 bytes`;
  }
  if (!isNonnegativeSafeInteger(opts?.epoch)) {
    return "epoch must be a nonnegative safe integer";
  }
  if (!isNonnegativeSafeInteger(opts?.oversizedSeq)) {
    return "oversizedSeq must be a nonnegative safe integer";
  }
}

export async function seedOversizedHistory({
  project_id,
  path,
  epoch,
  oversizedSeq,
  syncdbOf,
  syncClient,
  now = Date.now,
  limits,
}: {
  project_id: string;
  path: string;
  epoch: number;
  oversizedSeq: number;
  // for tests (see SyncDoc.seedHistoryFromLiveValue)
  limits?: { stepMs?: number; reserveMs?: number; valueBytes?: number };
  // the notebook's live syncdb in this backend, if it is running
  syncdbOf: (ipynbPath: string) => SyncDocLike | undefined;
  syncClient: Pick<SyncClient, "historyResetState">;
  now?: () => number;
}): Promise<SeedOversizedHistoryResult> {
  const invalid = validSeedRequest({ path, epoch, oversizedSeq });
  if (invalid) return { seeded: false, reason: "invalid", message: invalid };
  const ipynb_path = ipynbPath(path);
  const syncPath = syncdbPath(ipynb_path);
  const syncdb = syncdbOf(ipynb_path);
  if (syncdb == null) return { seeded: false, reason: "not-running" };
  // a backend that is itself stuck on the 413 is not a live writer
  if (
    !syncdb.isReady() ||
    typeof syncdb.seedHistoryFromLiveValue != "function"
  ) {
    return { seeded: false, reason: "not-ready" };
  }
  // as for (B): the slot is released only when every RPC this run started
  // has settled (LIMIT-H1B3B-1)
  const run = startRun(syncPath, {
    deadlineMs: RESTART_LIMITS.deadlineMs,
    now,
  });
  if (run == null) return { seeded: false, reason: "busy" };
  const { deadlineAt, track } = run;
  try {
    if (
      !(await gateAllowsReset({
        syncPath,
        project_id,
        syncClient,
        deadlineAt,
        now,
        track,
      }))
    ) {
      return {
        seeded: false,
        reason: "busy",
        message: "a reset of this notebook's history is already in progress",
      };
    }
    return await syncdb.seedHistoryFromLiveValue({
      epoch,
      deadlineAt,
      limits,
      track,
      gate: {
        beforeReset: ({ opId, epoch, revision }) => {
          // the one unresolved reset of this notebook
          return setUnresolvedReset(syncPath, {
            opId,
            epoch,
            revision,
            observedAt: now(),
          });
        },
        answered: (opId) => resolveGate(syncPath, opId),
      },
    });
  } catch (err) {
    if (err instanceof DeadlineExpired) {
      return { seeded: false, reason: "deadline" };
    }
    logger.debug("seedOversizedHistory failed", { path, err: `${err}` });
    return { seeded: false, reason: "failed", message: `${err}` };
  } finally {
    run.finish();
  }
}
