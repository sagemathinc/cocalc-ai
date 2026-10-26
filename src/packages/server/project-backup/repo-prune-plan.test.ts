/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rustic as installedRusticPath } from "@cocalc/backend/sandbox/install";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { uuid } from "@cocalc/util/misc";

const centralLogMock = jest.fn();
jest.mock("@cocalc/database/postgres/central-log", () => ({
  __esModule: true,
  default: (...args: any[]) => centralLogMock(...args),
}));

import { ensureProjectBackupRepoSchema } from "./index";
import {
  bytesOf,
  estimatePruneCost,
  getProjectBackupRepoPrunePlan,
  parseRusticPruneStats,
  runAuditedProjectBackupRepoPrunePlan,
  validatePruneLimit,
} from "./repo-prune-plan";

// rustic 0.11's statistics for a dry-run prune (on stderr).
const STATS = `[INFO] using config /tmp/x/repo.toml
[INFO] repository opendal:s3: password is correct.
[INFO] using no cache
[INFO] to repack:          3 packs,         40 blobs,   12.5 MiB
[INFO] this removes:                        25 blobs,    7.5 MiB
[INFO] to delete:          2 packs,          6 blobs,    1.9 GiB
[INFO] total prune:                         31 blobs,    1.9 GiB
[INFO] remaining:                          700 blobs,   15.2 GiB
[INFO] unused size after prune:     1.1 GiB (7.24% of remaining size)
[INFO] packs marked for deletion:          4,   10.0 MiB
[INFO]  - complete deletion:               1,    2.0 MiB
[INFO]  - keep marked:                     3,    8.0 MiB
[INFO]  - recover:                         0,        0 B
`;

// Stands in for rustic: logs its arguments, then answers according to the
// password in the profile it was given.
const FAKE_RUSTIC = `#!/bin/sh
PATH=/usr/bin:/bin
dir=$(dirname "$0")
echo "$*" >> "$dir/calls.log"
profile=""
cmd=""
for a in "$@"; do
  case "$prev" in -P) profile="$a" ;; esac
  case "$a" in prune|repoinfo) cmd="$a" ;; esac
  prev="$a"
done
pw=$(sed -n 's/^password = "\\(.*\\)"$/\\1/p' "$profile.toml")
case "$pw" in
  bad)
    printf 'Message:\\nThe password that has been entered, seems to be incorrect (bad, AKIAFAKE).\\n' >&2
    exit 1 ;;
  slow) sleep 3; cat "$dir/stats.txt" >&2; exit 0 ;;
  slowish) sleep 1; cat "$dir/stats.txt" >&2; exit 0 ;;
esac
case "$cmd" in
  prune) cat "$dir/stats.txt" >&2; exit 0 ;;
  repoinfo)
    echo '{"index":{"packs":[{"blob_type":"tree","count":2,"min_size":1000,"max_size":2000},{"blob_type":"data","count":9,"min_size":4194304,"max_size":12582912}]}}'
    exit 0 ;;
esac
exit 2
`;

function toml(password: string): string {
  return [
    "[repository]",
    'repository = "opendal:s3"',
    `password = "${password}"`,
    "",
    "[repository.options]",
    'access_key_id = "AKIAFAKE"',
    'secret_access_key = "s3-secret"',
    "",
  ].join("\n");
}

let dir: string;
let rusticPath: string;

async function calls(): Promise<string[]> {
  try {
    return (await readFile(join(dir, "calls.log"), "utf8"))
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function addRepo() {
  const id = uuid();
  await getPool().query(
    `INSERT INTO project_backup_repos (id, region, bucket_id, root, secret, status)
     VALUES ($1, 'wnam', $2, $3, 'v1:not-used', 'sealed')`,
    [id, uuid(), `rustic/shared-wnam-${id.slice(0, 4)}`],
  );
  return id;
}

describe("parseRusticPruneStats", () => {
  it("reads every statistic rustic prints", () => {
    const { stats, lines } = parseRusticPruneStats(STATS);
    expect(stats).toEqual({
      to_repack: { packs: 3, blobs: 40, bytes: Math.round(12.5 * 2 ** 20) },
      this_removes: { blobs: 25, bytes: Math.round(7.5 * 2 ** 20) },
      to_delete: { packs: 2, blobs: 6, bytes: Math.round(1.9 * 2 ** 30) },
      total_prune: { blobs: 31, bytes: Math.round(1.9 * 2 ** 30) },
      remaining: { blobs: 700, bytes: Math.round(15.2 * 2 ** 30) },
      unused_size_after_prune: {
        bytes: Math.round(1.1 * 2 ** 30),
        percent: 7.24,
      },
      packs_marked_for_deletion: { packs: 4, bytes: 10 * 2 ** 20 },
      complete_deletion: { packs: 1, bytes: 2 * 2 ** 20 },
      keep_marked: { packs: 3, bytes: 8 * 2 ** 20 },
      recover: { packs: 0, bytes: 0 },
    });
    expect(lines).toHaveLength(10);
    expect(lines.join("\n")).not.toContain("password");
  });

  it("estimates the work of a real prune", () => {
    const { stats } = parseRusticPruneStats(STATS);
    const repoinfo = {
      index: {
        packs: [
          { blob_type: "data", min_size: 4 * 2 ** 20, max_size: 12 * 2 ** 20 },
        ],
      },
    };
    expect(estimatePruneCost(stats, repoinfo)).toMatchObject({
      repack_read_bytes: Math.round(12.5 * 2 ** 20),
      repack_write_bytes:
        Math.round(12.5 * 2 ** 20) - Math.round(7.5 * 2 ** 20),
      // Marked now, freed by a later prune after --keep-delete.
      eventually_freed_bytes: Math.round(1.9 * 2 ** 30),
      packs_read: 3,
      packs_marked_for_deletion: 5,
      // Removed by this run: packs an earlier prune marked.
      removed_now_packs: 1,
      removed_now_bytes: 2 * 2 ** 20,
      // 5 MiB written into ~8 MiB packs, plus an index file.
      class_a_ops: 2,
      class_b_ops_min: 3,
    });
    expect(estimatePruneCost(stats).class_a_ops).toBeNull();
  });
});

describe("bytesOf", () => {
  it("reads every unit rustic prints, in any case", () => {
    expect(bytesOf("0 B")).toBe(0);
    for (const unit of ["KiB", "kiB", "KIB", "kib"]) {
      expect(bytesOf(`1.5 ${unit}`)).toBe(1536);
    }
    for (const unit of ["MiB", "miB", "mib"]) {
      expect(bytesOf(`2 ${unit}`)).toBe(2 * 2 ** 20);
    }
    for (const unit of ["GiB", "giB", "gib"]) {
      expect(bytesOf(`1 ${unit}`)).toBe(2 ** 30);
    }
    expect(bytesOf("1 TiB")).toBe(2 ** 40);
    for (const unit of ["kB", "KB", "kb"]) {
      expect(bytesOf(`3 ${unit}`)).toBe(3000);
    }
    expect(bytesOf("2 MB")).toBe(2e6);
    // The last size on the line, not a count of blobs.
    expect(bytesOf("3 packs,   40 blobs,   12.5 kiB")).toBe(12800);
    expect(bytesOf("40 blobs")).toBeUndefined();
  });

  it("counts unindexed packs, which rustic prints only when there are some", () => {
    const withUnindexed = STATS.replace(
      "[INFO] total prune:",
      "[INFO] unindexed:          4 packs,         ?? blobs,  300.0 MiB\n[INFO] total prune:",
    );
    const { stats, lines } = parseRusticPruneStats(withUnindexed);
    expect(stats.unindexed).toEqual({ packs: 4, bytes: 300 * 2 ** 20 });
    expect(lines.some((line) => line.startsWith("unindexed:"))).toBe(true);
    const estimate = estimatePruneCost(stats);
    // 3 repacked + 2 unused + 4 unindexed.
    expect(estimate.packs_marked_for_deletion).toBe(9);
    // rustic's total prune size already includes the unindexed bytes.
    expect(estimate.eventually_freed_bytes).toBe(stats.total_prune?.bytes);
    expect(parseRusticPruneStats(STATS).stats.unindexed).toBeUndefined();
  });

  it("parses statistics printed with lowercase binary units", () => {
    const { stats } = parseRusticPruneStats(
      STATS.replace(/MiB/g, "miB").replace(/GiB/g, "giB"),
    );
    expect(stats.total_prune?.bytes).toBe(Math.round(1.9 * 2 ** 30));
    expect(stats.to_repack?.bytes).toBe(Math.round(12.5 * 2 ** 20));
  });
});

describe("validatePruneLimit", () => {
  it("accepts rustic limits and nothing else", () => {
    for (const ok of ["0", "5%", "2.5%", "unlimited", "100MiB", "1 GiB"]) {
      expect(validatePruneLimit("max_unused", ok)).toBe(ok.replace(/\s+/g, ""));
    }
    expect(validatePruneLimit("max_unused", "")).toBeNull();
    for (const bad of [
      "--instant-delete",
      "5%;rm",
      "-1",
      "lots",
      "0 --repack-all",
    ]) {
      expect(() => validatePruneLimit("max_unused", bad)).toThrow(
        "max_unused must be",
      );
    }
  });
});

describe("getProjectBackupRepoPrunePlan", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
    await ensureProjectBackupRepoSchema();
    dir = await mkdtemp(join(tmpdir(), "fake-rustic-prune-"));
    rusticPath = join(dir, "rustic");
    await writeFile(rusticPath, FAKE_RUSTIC);
    await chmod(rusticPath, 0o755);
    await writeFile(join(dir, "stats.txt"), STATS);
    await mkdir(join(dir, "tmp"));
  }, 15000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await getPool().end();
  });

  beforeEach(async () => {
    await rm(join(dir, "calls.log"), { force: true });
    await getPool().query("DELETE FROM project_backup_repos");
  });

  const deps = (password: string) => ({
    rusticPath,
    tempRoot: join(dir, "tmp"),
    loadToml: async () => toml(password),
  });

  it("runs only a dry-run prune, and returns its statistics", async () => {
    const repo_id = await addRepo();
    const plan = await getProjectBackupRepoPrunePlan({
      repo_id,
      max_unused: "0",
      deps: deps("good"),
    });
    expect(plan).toMatchObject({
      repo_id,
      region: "wnam",
      status: "sealed",
      dry_run: true,
      options: { max_unused: "0", max_repack: null },
      stats: { to_delete: { packs: 2 } },
    });
    expect(plan.repoinfo).toBeUndefined();
    const log = await calls();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(
      /^-P \S+\/repo --no-cache --no-progress --dry-run prune --max-unused 0$/,
    );
    // The profile, with the repository's secrets, is gone.
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  });

  it("adds the index summary with --repoinfo", async () => {
    const repo_id = await addRepo();
    const plan = await getProjectBackupRepoPrunePlan({
      repo_id,
      repoinfo: true,
      max_repack: "10%",
      deps: deps("good"),
    });
    const log = await calls();
    expect(log[0]).toMatch(/--dry-run prune --max-repack 10%$/);
    expect(log[1]).toMatch(/--no-progress repoinfo --json --only-index$/);
    expect(plan.repoinfo).toMatchObject({
      index: { packs: expect.any(Array) },
    });
    expect(plan.estimate.class_a_ops).toEqual(expect.any(Number));
  });

  it("never runs prune without --dry-run", async () => {
    const repo_id = await addRepo();
    await getProjectBackupRepoPrunePlan({
      repo_id,
      repoinfo: true,
      deps: deps("good"),
    });
    for (const line of await calls()) {
      // The subcommand, not the temporary directory's name.
      if (/\sprune(\s|$)/.test(line)) {
        expect(line).toMatch(/\s--dry-run prune(\s|$)/);
      }
      expect(line).not.toMatch(/\binit\b|instant-delete|repack-all/);
    }
  });

  it("reports rustic's error without the repository's secrets", async () => {
    const repo_id = await addRepo();
    const err = await getProjectBackupRepoPrunePlan({
      repo_id,
      deps: deps("bad"),
    }).catch((e) => e);
    expect(`${err}`).toContain("password that has been entered");
    expect(`${err}`).not.toContain("AKIAFAKE");
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  });

  it("refuses bad input, unknown repositories, and a second plan at once", async () => {
    await expect(
      getProjectBackupRepoPrunePlan({ repo_id: "nope", deps: deps("good") }),
    ).rejects.toThrow("valid uuid");
    await expect(
      getProjectBackupRepoPrunePlan({ repo_id: uuid(), deps: deps("good") }),
    ).rejects.toThrow("no shared project backup repository");
    const repo_id = await addRepo();
    await expect(
      getProjectBackupRepoPrunePlan({
        repo_id,
        max_unused: "5% --instant-delete",
        deps: deps("good"),
      }),
    ).rejects.toThrow("max_unused must be");
    const slow = getProjectBackupRepoPrunePlan({
      repo_id,
      timeout_ms: 60_000,
      deps: deps("slow"),
    }).catch((e) => e);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(
      getProjectBackupRepoPrunePlan({ repo_id, deps: deps("good") }),
    ).rejects.toThrow("already running");
    expect(await slow).toMatchObject({ dry_run: true });
  }, 30000);

  it("is one plan per bay, also across connections (API replicas)", async () => {
    const repo_id = await addRepo();
    const other = await getPool().connect();
    try {
      const { rows } = await other.query(
        "SELECT pg_try_advisory_lock(hashtext('project-backup-repo-prune-plan')) AS locked",
      );
      expect(rows[0].locked).toBe(true);
      await expect(
        getProjectBackupRepoPrunePlan({ repo_id, deps: deps("good") }),
      ).rejects.toThrow("already running");
      expect(await calls()).toEqual([]);
    } finally {
      await other.query(
        "SELECT pg_advisory_unlock(hashtext('project-backup-repo-prune-plan'))",
      );
      other.release();
    }
    // Free again.
    await expect(
      getProjectBackupRepoPrunePlan({ repo_id, deps: deps("good") }),
    ).resolves.toMatchObject({ dry_run: true });
  });

  it("records every run, successful or not, in the central log", async () => {
    centralLogMock.mockReset().mockResolvedValue(undefined);
    const repo_id = await addRepo();
    const who = {
      actor_account_id: "11111111-1111-4111-8111-111111111111",
      source_bay_id: "bay-attached",
      bay_id: "bay-seed",
      repo_id,
      max_unused: "5%",
    };
    await runAuditedProjectBackupRepoPrunePlan({ ...who, deps: deps("good") });
    expect(centralLogMock).toHaveBeenLastCalledWith({
      event: "project_backup_repo_prune_plan",
      value: expect.objectContaining({
        account_id: who.actor_account_id,
        source_bay_id: "bay-attached",
        bay_id: "bay-seed",
        repo_id,
        max_unused: "5%",
        ok: true,
        total_prune_bytes: Math.round(1.9 * 2 ** 30),
      }),
    });
    await expect(
      runAuditedProjectBackupRepoPrunePlan({ ...who, deps: deps("bad") }),
    ).rejects.toThrow("password");
    const failed = centralLogMock.mock.calls.at(-1)![0];
    expect(failed.value).toMatchObject({ ok: false, repo_id });
    expect(JSON.stringify(failed)).not.toContain("AKIAFAKE");
  });

  it("keeps the whole run within one time budget", async () => {
    const repo_id = await addRepo();
    const plan = await getProjectBackupRepoPrunePlan({
      repo_id,
      repoinfo: true,
      deps: { ...deps("slowish"), timeoutMs: 1500 },
    });
    // The prune used most of the budget, so repoinfo never started.
    expect(plan.repoinfo).toBeNull();
    expect(plan.repoinfo_error).toContain("used up");
    expect((await calls()).some((line) => /\srepoinfo\s/.test(line))).toBe(
      false,
    );
  });

  // The real binary, where installed: the statistics parse, and a dry run
  // leaves every repository file as it was.
  const realRustic = [installedRusticPath, "/opt/cocalc/bin2/rustic"].find(
    (path) => path && existsSync(path),
  );
  (realRustic ? it : it.skip)(
    "works with the real rustic binary and changes nothing",
    async () => {
      const work = await mkdtemp(join(tmpdir(), "real-prune-"));
      try {
        const repoDir = join(work, "repo");
        const profile = `[repository]\nrepository = "${repoDir}"\npassword = "pw"\n`;
        await writeFile(join(work, "p.toml"), profile);
        const run = (...args: string[]) =>
          execFileSync(
            realRustic!,
            ["-P", join(work, "p"), "--no-cache", ...args],
            {
              env: { HOME: work },
              stdio: ["ignore", "pipe", "pipe"],
            },
          ).toString();
        run("init");
        for (const host of ["ha", "hb"]) {
          const src = join(work, host);
          await mkdir(src);
          await writeFile(join(src, "f"), Buffer.alloc(300_000, host));
          run("backup", "--host", host, src);
        }
        const snapshots = JSON.parse(
          run("snapshots", "--json", "--filter-host", "hb"),
        );
        const id = JSON.stringify(snapshots).match(/"id":"([0-9a-f]{64})"/)![1];
        run("forget", id);
        const files = () =>
          readdirSync(repoDir, { recursive: true })
            .map((f) => `${f}`)
            .sort()
            .map((f) => {
              const st = statSync(join(repoDir, f));
              return `${f}:${st.isFile() ? st.size : "d"}:${st.mtimeMs}`;
            });
        const before = files();
        const repo_id = await addRepo();
        const plan = await getProjectBackupRepoPrunePlan({
          repo_id,
          repoinfo: true,
          max_unused: "0",
          deps: { rusticPath: realRustic, loadToml: async () => profile },
        });
        expect(plan.stats.to_delete?.packs).toBeGreaterThan(0);
        expect(plan.stats.total_prune?.bytes).toBeGreaterThan(0);
        expect(plan.repoinfo).toMatchObject({ index: expect.any(Object) });
        expect(files()).toEqual(before);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
    60000,
  );
});
