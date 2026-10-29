/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { uuid } from "@cocalc/util/misc";

import { ensureProjectBackupRepoSchema } from "./index";
import {
  READ_DATA_SUBSET,
  checkProjectBackupRepoSample,
  getProjectBackupRepoSampledCheckHealth,
  parseSnapshotIds,
  projectBackupRepoSampledCheckDetails,
  projectBackupRepoSampledCheckLevel,
  projectBackupRepoSampledCheckSummary,
  runProjectBackupRepoSampledCheck,
} from "./repo-sampled-check";

const SNAPSHOTS = ["a", "b", "c", "d", "e"].map((c) => c.repeat(64));

// Stands in for rustic: logs its arguments, then behaves according to the
// password in the profile it was given.
const FAKE_RUSTIC = `#!/bin/sh
PATH=/usr/bin:/bin
dir=$(dirname "$0")
echo "$*" >> "$dir/calls.log"
profile=""
cmd=""
args=""
while [ $# -gt 0 ]; do
  case "$1" in
    -P) profile="$2"; shift 2 ;;
    --*) shift ;;
    *) if [ -z "$cmd" ]; then cmd="$1"; else args="$args $1"; fi; shift ;;
  esac
done
pw=$(sed -n 's/^password = "\\(.*\\)"$/\\1/p' "$profile.toml")
case "$pw" in
  bad)
    printf 'Message:\\nThe password that has been entered, seems to be incorrect. No suitable key found for the given password.\\n' >&2
    exit 1 ;;
  slow) exec sleep 10 ;;
esac
if [ "$cmd" = "list" ]; then
  [ "$pw" = "empty" ] && exit 0
  for s in ${SNAPSHOTS.join(" ")}; do echo "SnapshotId($s)"; done
  exit 0
fi
case "$pw" in
  damaged)
    printf '[ERROR] pack 46f99e29 is referenced by the index but not present! (key AKIAFAKE)\\n[ERROR] pack 8817bfa3: Hash mismatch.\\nerror: rustic_core experienced an error related to the repository.\\n\\nMessage:\\ncheck found errors!\\n' >&2
    exit 1 ;;
  forgotten)
    case "$args" in
      *${SNAPSHOTS[0]}*)
        printf 'Message:\\nFailed to read the contents of the file.\\n- path: /r/snapshots/${SNAPSHOTS[0]}\\n' >&2
        exit 1 ;;
    esac ;;
esac
exit 0
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

// The snapshot ids given to each `check`.
async function checkedIds(): Promise<string[][]> {
  return (await calls())
    .filter((line) => / check /.test(line))
    .map((line) => line.split(" ").filter((arg) => /^[0-9a-f]{64}$/.test(arg)));
}

async function addRepo(status: string, updated = new Date()) {
  const id = uuid();
  await getPool().query(
    `INSERT INTO project_backup_repos
       (id, region, bucket_id, root, secret, status, created, updated)
     VALUES ($1, 'wnam', $2, $3, 'v1:not-used', $4, $5, $5)`,
    [id, uuid(), `rustic/shared-wnam-${id.slice(0, 4)}`, status, updated],
  );
  return id;
}

describe("sampled check of sealed project backup repositories", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
    await ensureProjectBackupRepoSchema();
    dir = await mkdtemp(join(tmpdir(), "fake-rustic-"));
    rusticPath = join(dir, "rustic");
    await writeFile(rusticPath, FAKE_RUSTIC);
    await chmod(rusticPath, 0o755);
  }, 15000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await getPool().end();
  });

  beforeEach(async () => {
    await rm(join(dir, "calls.log"), { force: true });
    await getPool().query("DELETE FROM project_backup_repos");
    await getPool()
      .query("DELETE FROM project_backup_repo_sampled_checks WHERE true")
      .catch(() => {});
  });

  describe("checkProjectBackupRepoSample", () => {
    const check = (password: string, extra = {}) =>
      checkProjectBackupRepoSample("repo", {
        rusticPath,
        tempRoot: dir,
        loadToml: async () => toml(password),
        ...extra,
      });

    it("checks a few random snapshots and a bounded subset of their data, read-only", async () => {
      expect(await check("good")).toMatchObject({
        result: "ok",
        snapshots_checked: 3,
      });
      const log = await calls();
      expect(log).toHaveLength(2);
      expect(log[0]).toMatch(/--no-cache --no-progress list snapshots$/);
      expect(log[1]).toMatch(
        new RegExp(
          `--no-cache --no-progress check --read-data --read-data-subset ${READ_DATA_SUBSET} `,
        ),
      );
      const [ids] = await checkedIds();
      expect(new Set(ids).size).toBe(3);
      for (const id of ids) expect(SNAPSHOTS).toContain(id);
      // Only these two read-only subcommands ever run.
      expect(
        log.map((line) =>
          line
            .split(" ")
            .slice(2)
            .find((arg) => !arg.startsWith("-")),
        ),
      ).toEqual(["list", "check"]);
    });

    it("checks just the index and packs of a repository without snapshots", async () => {
      expect(await check("empty")).toMatchObject({
        result: "ok",
        snapshots_checked: 0,
      });
      expect(await checkedIds()).toEqual([[]]);
    });

    it("reports missing or corrupt packs as damage, without secrets", async () => {
      const outcome = await check("damaged");
      expect(outcome).toMatchObject({
        result: "failed",
        error_kind: "damaged",
      });
      expect(outcome.error).toBe(
        "2 errors; first: pack 46f99e29 is referenced by the index but not present! (key ***)",
      );
    });

    it("classifies a wrong password", async () => {
      expect(await check("bad")).toMatchObject({
        result: "failed",
        error_kind: "wrong_password",
      });
    });

    it("reports a timeout", async () => {
      expect(
        await check("slow", { timeoutMs: 300, listTimeoutMs: 300 }),
      ).toMatchObject({ result: "failed", error_kind: "timeout" });
    });

    it("chooses again when a purge forgot a chosen snapshot", async () => {
      // Keeps the listing order, so the first snapshot is among the chosen.
      expect(await check("forgotten", { random: () => 0.999 })).toMatchObject({
        result: "ok",
        snapshots_checked: 3,
      });
      const [first, second] = await checkedIds();
      expect(first).toContain(SNAPSHOTS[0]);
      expect(second).not.toContain(SNAPSHOTS[0]);
      expect(second).toHaveLength(3);
    });
  });

  it("parses rustic's snapshot listing", () => {
    expect(
      parseSnapshotIds(
        `SnapshotId(${SNAPSHOTS[0]})\n${SNAPSHOTS[1]}\nnoise\nSnapshotId(${SNAPSHOTS[0]})\n`,
      ),
    ).toEqual([SNAPSHOTS[0], SNAPSHOTS[1]]);
  });

  it("checks one sealed or draining repository per run, quarterly, and failed ones daily", async () => {
    const sealed = await addRepo("sealed");
    const draining = await addRepo("draining");
    const damaged = await addRepo("sealed");
    await addRepo("active");
    await addRepo("disabled");
    const passwords: Record<string, string> = {
      [sealed]: "good",
      [draining]: "good",
      [damaged]: "damaged",
    };
    let now = new Date("2026-10-29T12:00:00Z");
    const deps = {
      rusticPath,
      tempRoot: dir,
      now: () => now,
      loadToml: async (id: string) => toml(passwords[id] ?? "unexpected"),
    };
    const checked: string[] = [];
    for (let i = 0; i < 4; i++) {
      const run = await runProjectBackupRepoSampledCheck(deps);
      if (run) checked.push(run.repo_id);
      now = new Date(now.getTime() + 60 * 60 * 1000);
    }
    // Each of the three, once; then nothing is due.
    expect(checked.sort()).toEqual([sealed, draining, damaged].sort());
    const { rows } = await getPool().query(
      "SELECT repo_id, last_result, last_error_kind, snapshots_checked, read_data_subset FROM project_backup_repo_sampled_checks",
    );
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.repo_id === damaged)).toMatchObject({
      last_result: "failed",
      last_error_kind: "damaged",
    });
    expect(rows.find((r) => r.repo_id === sealed)).toMatchObject({
      last_result: "ok",
      snapshots_checked: 3,
      read_data_subset: READ_DATA_SUBSET,
    });

    // A day later the damaged one is checked again ...
    now = new Date("2026-10-30T15:00:00Z");
    expect((await runProjectBackupRepoSampledCheck(deps))?.repo_id).toBe(
      damaged,
    );
    expect(await runProjectBackupRepoSampledCheck(deps)).toBeUndefined();
    // ... and 90 days later the others.
    now = new Date("2027-01-28T12:30:00Z");
    expect([sealed, draining]).toContain(
      (await runProjectBackupRepoSampledCheck(deps))?.repo_id,
    );
  });

  it("warns about failed and overdue checks, after a grace period for new ones", async () => {
    const now = new Date("2026-10-29T12:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    const ago = (days: number) => new Date(now.getTime() - days * day);
    await addRepo("active", ago(500));

    // Before the scheduler first runs, from when the repository was sealed.
    const recent = await addRepo("sealed", ago(3));
    let health = await getProjectBackupRepoSampledCheckHealth({ now });
    expect(health).toMatchObject({ repos: 1, current: 0, pending: 1 });
    expect(projectBackupRepoSampledCheckLevel(health)).toBe("healthy");
    const old = await addRepo("sealed", ago(400));
    health = await getProjectBackupRepoSampledCheckHealth({ now });
    expect(health.problems).toEqual([
      expect.objectContaining({ repo_id: old, problem: "stale" }),
    ]);
    expect(projectBackupRepoSampledCheckLevel(health)).toBe("warning");

    // Once the scheduler has seen them, from then on.
    await getPool().query(
      `INSERT INTO project_backup_repo_sampled_checks (repo_id, first_seen_at)
       VALUES ($1, $2), ($3, $2)`,
      [recent, ago(1), old],
    );
    health = await getProjectBackupRepoSampledCheckHealth({ now });
    expect(health).toMatchObject({ repos: 2, pending: 2, problems: [] });
    await getPool().query(
      "UPDATE project_backup_repo_sampled_checks SET first_seen_at = $1",
      [ago(15)],
    );
    health = await getProjectBackupRepoSampledCheckHealth({ now });
    expect(health.problems.map((p) => p.problem)).toEqual(["stale", "stale"]);

    // Checked within 100 days: current; a failed check is a problem.
    await getPool().query(
      `UPDATE project_backup_repo_sampled_checks
          SET last_check_at = $2, last_result = 'ok', last_ok_at = $2
        WHERE repo_id = $1`,
      [recent, ago(99)],
    );
    await getPool().query(
      `UPDATE project_backup_repo_sampled_checks
          SET last_check_at = $2, last_result = 'failed',
              last_error_kind = 'damaged', last_error = 'pack 46f99e29 missing'
        WHERE repo_id = $1`,
      [old, ago(1)],
    );
    health = await getProjectBackupRepoSampledCheckHealth({ now });
    expect(health).toMatchObject({ repos: 2, current: 1, pending: 0 });
    expect(projectBackupRepoSampledCheckLevel(health)).toBe("warning");
    expect(projectBackupRepoSampledCheckSummary(health)).toBe(
      "1/2 sealed backup repositories passed a sampled pack check within 100 days (1 latest failed, 0 overdue, 0 new awaiting a first check).",
    );
    expect(projectBackupRepoSampledCheckDetails(health)).toEqual([
      `${old} (wnam, sealed): sampled check failed at ${ago(1).toISOString()}: damaged: pack 46f99e29 missing`,
    ]);

    // Over 100 days: overdue.
    health = await getProjectBackupRepoSampledCheckHealth({
      now: new Date(now.getTime() + 2 * day),
    });
    expect(health.problems.map((p) => [p.repo_id, p.problem]).sort()).toEqual(
      [
        [old, "failed"],
        [recent, "stale"],
      ].sort(),
    );

    // An attached bay reports nothing of its own.
    health = await getProjectBackupRepoSampledCheckHealth({
      now,
      seed_managed: true,
    });
    expect(projectBackupRepoSampledCheckLevel(health)).toBe("healthy");
    expect(projectBackupRepoSampledCheckSummary(health)).toMatch(/seed bay/);
  });
});
