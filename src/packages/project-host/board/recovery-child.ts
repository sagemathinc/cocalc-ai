/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The board recovery child (isolation plan, r7): reconstructs a board from its
stored stream records, in its own process, as its own unprivileged user, in
its own memory cgroup. It has no conat client, no write fence and no
credentials, and publishes nothing: it returns the value, a verdict and the
patch ids, and the host's runner (recovery.ts) decides what to do with them.

The protocol (conat/board-recovery/frame.ts): the child first writes a hello
(its identity, fds, cgroup and limits, read from /proc and its leaf), then
reads one job frame from stdin, and writes one result frame and exits 0.
Anything else (a bad frame, a value over the cap) exits non-zero. The child
learns its job id from its leaf's name (job-<id>), so it takes no arguments
and no environment.

reconstruct() runs only on records the frame scan and decoder accepted, and
scans each record's own bytes (with the record limits, depth 32 as G1's
record contract) before decoding it.
*/

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  FrameReader,
  ProtocolError,
  RECOVERY_VALUE_CAP,
  decodeFrameBody,
  encodeFrame,
  type HelloFrame,
  type JobRecord,
  type ResultFrame,
  type Verdict,
} from "@cocalc/conat/board-recovery/frame";
import { scanMsgpack } from "@cocalc/conat/board-recovery/msgpack-scan";
import { DataEncoding, decode } from "@cocalc/conat/core/codec";
import { digestOf } from "@cocalc/conat/persist/board-append";
import {
  BOARD_HISTORY_LIMITS,
  BoardHistoryCheck,
} from "@cocalc/conat/persist/board-history";
import {
  graphFromRecords,
  patchflowCodec,
} from "@cocalc/sync/editor/generic/patchflow-record";
import { from_str as immerFromStr } from "@cocalc/sync/editor/immer-db/doc";
import {
  BOARD_PRIMARY_KEYS,
  BOARD_STRING_COLS,
} from "@cocalc/util/board/names";

// Where the child reads who and where it is. The installed entry point uses
// the real paths; tests pass their own (there is no override in the
// installed program).
export interface ChildPaths {
  // /proc/self/status
  status: string;
  // /proc/self/cgroup
  cgroup: string;
  // /proc/self/fd
  fdDir: string;
  // The cgroup v2 mount, /sys/fs/cgroup.
  cgroupRoot: string;
}

export const REAL_PATHS: ChildPaths = {
  status: "/proc/self/status",
  cgroup: "/proc/self/cgroup",
  fdDir: "/proc/self/fd",
  cgroupRoot: "/sys/fs/cgroup",
};

const LEAF = /\/job-([0-9a-f]{32})$/;

export function readHello(paths: ChildPaths): HelloFrame {
  const status = readFileSync(paths.status, "utf8");
  const field = (name: string): string => {
    const line = status.split("\n").find((l) => l.startsWith(`${name}:`));
    if (line == null) throw Error(`no ${name} in ${paths.status}`);
    return line.slice(name.length + 1).trim();
  };
  // Real, effective, saved and filesystem ids must all be the same.
  const ids = (name: string): number => {
    const all = field(name).split(/\s+/).map(Number);
    if (all.length !== 4 || all.some((x) => x !== all[0])) {
      throw Error(`${name} ids differ: ${field(name)}`);
    }
    return all[0];
  };
  const groups = field("Groups")
    .split(/\s+/)
    .filter((x) => x !== "")
    .map(Number);
  // cgroup v2: one line, "0::<path>".
  const line = readFileSync(paths.cgroup, "utf8")
    .split("\n")
    .find((l) => l.startsWith("0::"));
  if (line == null) throw Error("not in a cgroup v2 hierarchy");
  const cgroup = line.slice(3).trim();
  const leaf = LEAF.exec(cgroup);
  if (leaf == null) throw Error(`not in a recovery job's leaf: ${cgroup}`);
  const leafDir = join(paths.cgroupRoot, cgroup);
  const read = (name: string) =>
    readFileSync(join(leafDir, name), "utf8").trim();
  const fds: HelloFrame["fds"] = [];
  for (const name of readdirSync(paths.fdDir)) {
    const fd = Number(name);
    let target: string;
    try {
      target = readlinkSync(join(paths.fdDir, name));
    } catch {
      // The fd of the listing itself, already closed.
      continue;
    }
    fds.push({ fd, target: target.slice(0, 4096) });
  }
  return {
    v: 1,
    type: "hello",
    job_id: leaf[1],
    uid: ids("Uid"),
    gid: ids("Gid"),
    groups,
    no_new_privs: Number(field("NoNewPrivs")),
    cap_eff: field("CapEff")
      .replace(/^0+(?=.)/, "")
      .toLowerCase(),
    cap_prm: field("CapPrm")
      .replace(/^0+(?=.)/, "")
      .toLowerCase(),
    fds,
    cgroup,
    limits: {
      memory_max: read("memory.max"),
      swap_max: read("memory.swap.max"),
    },
  };
}

// A record's own bytes, before it is decoded: G1's record contract (depth
// 32, its byte limit), with items bounded by its bytes.
function recordScanLimits(bytes: number) {
  return {
    maxDepth: BOARD_HISTORY_LIMITS.recordDepth,
    maxElements: bytes,
    maxStrLength: BOARD_HISTORY_LIMITS.recordBytes,
    maxBinLength: BOARD_HISTORY_LIMITS.recordBytes,
    maxArrayLength: bytes,
    maxMapLength: bytes,
  };
}

const CODEC = patchflowCodec({
  fromStr: (text) => immerFromStr(text, BOARD_PRIMARY_KEYS, BOARD_STRING_COLS),
  doctype: {
    type: "db",
    patch_format: 1,
    opts: { primary_keys: BOARD_PRIMARY_KEYS, string_cols: BOARD_STRING_COLS },
  },
});

type HistoryReason = "clean" | "too-large" | "incomplete" | "non-linear";

export interface Reconstruction {
  verdict: Verdict;
  value: string | null;
  identifiers: string[];
}

/*
The board a stream's stored records make, and what kind of history it is:
- invalid: a record that doesn't decode or isn't a board patch record (G1's
  record rules, depth 32 included), or two different records at one time;
- incomplete: a parent missing from inside the history (patchflow needs more
  history), or a value patchflow can only approximate;
- clean: a history G1 would open in-process;
- non-linear: every other complete history (branches, merges, a snapshot
  that isn't a cut, a suffix over G1's bounds).
Only clean and non-linear histories have a value.
*/
export function reconstruct(records: JobRecord[]): Reconstruction {
  const invalid: Reconstruction = {
    verdict: "invalid",
    value: null,
    identifiers: [],
  };
  const values: unknown[] = [];
  const check = new BoardHistoryCheck({
    ...BOARD_HISTORY_LIMITS,
    // Recovery reads histories G1 refused for their size too (within the
    // job frame's caps): sizes don't make a history invalid here.
    records: Number.MAX_SAFE_INTEGER,
    totalBytes: Number.MAX_SAFE_INTEGER,
    suffixRecords: BOARD_HISTORY_LIMITS.suffixRecords,
  });
  let verdict: HistoryReason | undefined;
  for (const { encoding, raw } of records) {
    let value: unknown;
    try {
      if (encoding === DataEncoding.MsgPack) {
        scanMsgpack(raw, recordScanLimits(raw.byteLength));
      } else if (encoding !== DataEncoding.JsonCodec) {
        return invalid;
      }
      value = decode({ encoding, data: Buffer.from(raw) });
    } catch {
      return invalid;
    }
    values.push(value);
    if (verdict == null) {
      const stop = check.add(
        value,
        raw.byteLength,
        digestOf(encoding, Buffer.from(raw)),
      );
      if (stop != null && !stop.ok) {
        if (stop.reason === "invalid") return invalid;
        verdict = stop.reason;
      }
    }
  }
  if (verdict == null) {
    const done = check.finish();
    if (!done.ok && done.reason === "invalid") return invalid;
    verdict = done.ok ? "clean" : (done.reason as HistoryReason);
  }
  let graph: ReturnType<typeof graphFromRecords>;
  try {
    graph = graphFromRecords({ records: values, codec: CODEC });
  } catch {
    return invalid;
  }
  const identifiers = [
    ...new Set(
      values
        .filter((v: any) => v?.is_snapshot !== true)
        .map((v: any) => String(v.time)),
    ),
  ].sort();
  if (
    verdict === "incomplete" ||
    graph.needsMoreHistory() ||
    graph.valueUnavailable()
  ) {
    return { verdict: "incomplete", value: null, identifiers };
  }
  const value = CODEC.toString(graph.value());
  if (Buffer.byteLength(value) > RECOVERY_VALUE_CAP) {
    throw Error(`the board's value is over ${RECOVERY_VALUE_CAP} bytes`);
  }
  return {
    verdict: verdict === "clean" ? "clean" : "non-linear",
    value,
    identifiers,
  };
}

/*
The child's whole life: hello, one job, one result. Resolves with the exit
code (0 only after a result was written in full).
*/
export async function runChild({
  input,
  output,
  paths = REAL_PATHS,
}: {
  input: Readable;
  output: Writable;
  paths?: ChildPaths;
}): Promise<number> {
  const hello = readHello(paths);
  await write(output, encodeFrame(hello));
  // The one job frame, accepted only at a clean end of input (astra
  // CORR-DFC-2): a byte after it, in the same chunk or later, a partial
  // frame, or no frame at all is a protocol error, and nothing is done.
  const body = await new Promise<Uint8Array>((resolve, reject) => {
    let job: Uint8Array | undefined;
    const reader = new FrameReader(["job"], (_kind, b) => (job = b));
    input.on("data", (chunk: Buffer) => {
      reader.push(chunk);
      if (reader.error) reject(reader.error);
    });
    input.on("end", () => {
      if (reader.error) return reject(reader.error);
      if (job == null || !reader.done || !reader.atBoundary) {
        return reject(new ProtocolError("no complete job before EOF"));
      }
      resolve(job);
    });
    input.on("error", reject);
  });
  const job = decodeFrameBody("job", body);
  if (job.job_id !== hello.job_id) {
    throw new ProtocolError("a job for another job id");
  }
  const input_sha256 = createHash("sha256").update(body).digest("hex");
  const { verdict, value, identifiers } = reconstruct(job.records);
  const result: ResultFrame = {
    v: 1,
    type: "result",
    job_id: job.job_id,
    input_sha256,
    verdict,
    value,
    identifiers,
  };
  await write(output, encodeFrame(result));
  await new Promise<void>((resolve) => output.end(resolve));
  return 0;
}

function write(output: Writable, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) =>
    output.write(bytes, (err) => (err ? reject(err) : resolve())),
  );
}
