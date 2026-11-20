/*
ALT-D2 (design note v8) performance: the write-burst cost of the records on
a journaled disk vs tmpfs.  arm = mkdir + write + rename, disarm = unlink +
rmdir, never fsync'd.  Runs only when COCALC_PERSIST_BENCH_DIRS lists the
directories to measure (comma-separated; e.g. a dir on the data disk and one
on /dev/shm); prints p50/p99/max per operation in microseconds, and writes
them as JSON to COCALC_PERSIST_BENCH_OUT if set.
*/

import * as fs from "node:fs";
import { join } from "node:path";

import { createDurabilityRecords } from "@cocalc/conat/persist/durability-records";
import { sha256Hex } from "@cocalc/backend/conat/persist-durability";

const dirs = (process.env.COCALC_PERSIST_BENCH_DIRS ?? "")
  .split(",")
  .map((d) => d.trim())
  .filter((d) => d);
const N = Number(process.env.COCALC_PERSIST_BENCH_N ?? 5000);
// distinct streams cycled through (a burst touches many keys)
const KEYS = Number(process.env.COCALC_PERSIST_BENCH_KEYS ?? 500);

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function stats(us: number[]) {
  const s = [...us].sort((a, b) => a - b);
  return {
    n: s.length,
    p50_us: Math.round(pct(s, 50) * 10) / 10,
    p99_us: Math.round(pct(s, 99) * 10) / 10,
    max_us: Math.round(s[s.length - 1] * 10) / 10,
  };
}

(dirs.length > 0 ? describe : describe.skip)("ALT-D2 write-burst measurement", () => {
  it("[PERF] arm/disarm p50/p99 per directory", () => {
    const results: Record<string, unknown> = {};
    for (const dir of dirs) {
      const root = fs.mkdtempSync(join(dir, "persist-burst-"));
      try {
        const r = createDurabilityRecords({
          root,
          generation: `bench-${process.pid}`,
          fs: fs as any,
          sha256: sha256Hex,
          pid: process.pid,
        });
        const arm: number[] = [];
        const disarm: number[] = [];
        // warm-up (directories created)
        for (let i = 0; i < 50; i++) {
          r.arm(`/w${i}`, "p");
          r.disarm(`/w${i}`);
        }
        for (let i = 0; i < N; i++) {
          const id = `/s${i % KEYS}`;
          let t = process.hrtime.bigint();
          r.arm(id, "p");
          arm.push(Number(process.hrtime.bigint() - t) / 1000);
          t = process.hrtime.bigint();
          r.disarm(id);
          disarm.push(Number(process.hrtime.bigint() - t) / 1000);
        }
        let fsType: string | undefined;
        try {
          fsType = `0x${Number((fs as any).statfsSync(root).type).toString(16)}`;
        } catch {}
        results[dir] = { fs_type: fsType, arm: stats(arm), disarm: stats(disarm) };
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
    const text = JSON.stringify({ n: N, keys: KEYS, results }, null, 2);
    process.stdout.write(`ALT-D2 write-burst:\n${text}\n`);
    if (process.env.COCALC_PERSIST_BENCH_OUT) {
      fs.writeFileSync(process.env.COCALC_PERSIST_BENCH_OUT, text + "\n");
    }
    expect(Object.keys(results).length).toBe(dirs.length);
  });
});
