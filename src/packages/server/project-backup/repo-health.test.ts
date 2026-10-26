/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { rustic as installedRusticPath } from "@cocalc/backend/sandbox/install";
import { uuid } from "@cocalc/util/misc";

const adminAlert = jest.fn();
jest.mock("@cocalc/server/messages/admin-alert", () => ({
  __esModule: true,
  default: (...args: any[]) => adminAlert(...args),
}));

import {
  ensureProjectBackupRepoSchema,
  getProjectBackupShardAdminStatus,
} from "./index";
import {
  classifyRusticError,
  getProjectBackupRepoHealth,
  probeProjectBackupRepo,
  removeLeftoverProbeProfiles,
  projectBackupRepoHealthLevel,
  projectBackupRepoHealthSummary,
  runProjectBackupRepoHealthCheck,
  runProjectBackupRepoProbes,
  summarizeRusticError,
} from "./repo-health";

// Stands in for rustic: logs its arguments, then behaves according to the
// password in the profile it was given.
const FAKE_RUSTIC = `#!/bin/sh
PATH=/usr/bin:/bin
dir=$(dirname "$0")
echo "$*" >> "$dir/calls.log"
profile=""
while [ $# -gt 0 ]; do
  case "$1" in
    -P) profile="$2"; shift 2 ;;
    *) shift ;;
  esac
done
pw=$(sed -n 's/^password = "\\(.*\\)"$/\\1/p' "$profile.toml")
case "$pw" in
  good) echo '{"version":2,"id":"abc"}'; exit 0 ;;
  bad)
    printf 'error: credentials handling\\nMessage:\\nThe password that has been entered, seems to be incorrect. No suitable key found for the given password.\\nFor more information, see: https://rustic.cli.rs/docs/errors/C002\\n' >&2
    exit 1 ;;
  slow) exec sleep 10 ;;
  *)
    printf 'Message:\\nNo repository config file found for opendal:s3 (password %s, key AKIAFAKE)\\n' "$pw" >&2
    exit 1 ;;
esac
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

async function addRepo(status: string | null, created = new Date()) {
  const id = uuid();
  await getPool().query(
    `INSERT INTO project_backup_repos
       (id, region, bucket_id, root, secret, status, created, updated)
     VALUES ($1, 'wnam', $2, $3, 'v1:not-used', COALESCE($4, 'active'), $5, $5)`,
    [id, uuid(), `rustic/shared-wnam-${id.slice(0, 4)}`, status, created],
  );
  return id;
}

describe("project backup repository health probe", () => {
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
    adminAlert.mockReset();
    await rm(join(dir, "calls.log"), { force: true });
    await getPool().query("DELETE FROM project_backup_repos");
    await getPool()
      .query("DELETE FROM project_backup_repo_probes WHERE true")
      .catch(() => {});
  });

  describe("probeProjectBackupRepo", () => {
    const probe = (password: string, extra = {}) =>
      probeProjectBackupRepo("repo", {
        rusticPath,
        loadToml: async () => toml(password),
        ...extra,
      });

    it("is ok when the config opens, and only ever reads it", async () => {
      expect(await probe("good")).toMatchObject({ result: "ok" });
      const log = await calls();
      expect(log).toHaveLength(1);
      expect(log[0]).toMatch(/^-P \S+\/repo --no-cache cat config$/);
      expect(log.join("\n")).not.toMatch(/\binit\b/);
    });

    it("classifies a wrong password", async () => {
      expect(await probe("bad")).toMatchObject({
        result: "failed",
        error_kind: "wrong_password",
        error: expect.stringContaining("password that has been entered"),
      });
    });

    it("classifies a missing config and never records a secret", async () => {
      const outcome = await probe("leak-me-123");
      expect(outcome).toMatchObject({
        result: "failed",
        error_kind: "missing_config",
      });
      expect(outcome.error).toContain("No repository config file found");
      expect(outcome.error).not.toContain("leak-me-123");
      expect(outcome.error).not.toContain("AKIAFAKE");
    });

    it("reports a timeout", async () => {
      expect(await probe("slow", { timeoutMs: 300 })).toMatchObject({
        result: "failed",
        error_kind: "timeout",
      });
    });

    it("fails without a usable configuration and without running rustic", async () => {
      expect(
        await probeProjectBackupRepo("repo", {
          rusticPath,
          loadToml: async () => "",
        }),
      ).toMatchObject({ result: "failed", error_kind: "no_config" });
      expect(
        await probeProjectBackupRepo("repo", {
          rusticPath,
          loadToml: async () => {
            throw new Error("bucket row missing");
          },
        }),
      ).toMatchObject({
        // Possibly transient (database, settings, site key): not deterministic.
        result: "failed",
        error_kind: "error",
        error: expect.stringContaining("bucket row missing"),
      });
      expect(await calls()).toEqual([]);
    });

    it("records a failure when the temporary profile cannot be created", async () => {
      expect(
        await probe("good", { tempRoot: join(dir, "does-not-exist") }),
      ).toMatchObject({ result: "failed", error_kind: "error" });
      expect(await calls()).toEqual([]);
    });

    it("reports a probe profile it could not remove", async () => {
      let leftover = "";
      const outcome = await probe("good", {
        removeTempDir: async (path: string) => {
          leftover = path;
          throw new Error("EBUSY");
        },
      });
      expect(outcome).toMatchObject({
        result: "failed",
        error_kind: "cleanup_failed",
      });
      expect(outcome.error).toContain(leftover);
      expect(outcome.error).toContain("holds the repository credentials");
      await rm(leftover, { recursive: true, force: true });
    });
  });

  // The real binary, where installed: the classification must match its
  // actual messages, and the probe must not create a repository.
  const realRustic = [installedRusticPath, "/opt/cocalc/bin2/rustic"].find(
    (path) => path && existsSync(path),
  );
  (realRustic ? it : it.skip)(
    "works with the real rustic binary",
    async () => {
      const repoDir = join(dir, "real-repo");
      const profile = (password: string, repository = repoDir) =>
        `[repository]\nrepository = "${repository}"\npassword = "${password}"\n`;
      await writeFile(join(dir, "init.toml"), profile("right"));
      execFileSync(realRustic!, ["-P", join(dir, "init"), "init"], {
        stdio: "ignore",
        env: { HOME: dir },
      });
      const probe = (toml: string) =>
        probeProjectBackupRepo("repo", {
          rusticPath: realRustic,
          loadToml: async () => toml,
        });
      expect(await probe(profile("right"))).toMatchObject({ result: "ok" });
      expect(await probe(profile("wrong"))).toMatchObject({
        result: "failed",
        error_kind: "wrong_password",
      });
      const missing = join(dir, "never-initialized");
      expect(await probe(profile("right", missing))).toMatchObject({
        result: "failed",
        error_kind: "missing_config",
      });
      expect(existsSync(missing)).toBe(false);
    },
    30000,
  );

  it("removes leftover probe profiles, and alerts on those it cannot", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-root-"));
    try {
      const now = new Date();
      const old = join(root, "cocalc-backup-repo-probe-old");
      const young = join(root, "cocalc-backup-repo-probe-young");
      const other = join(root, "something-else");
      for (const path of [old, young, other]) {
        await mkdir(path);
        await writeFile(join(path, "repo.toml"), toml("good"));
      }
      const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      await utimes(old, hourAgo, hourAgo);
      await utimes(other, hourAgo, hourAgo);
      expect(await removeLeftoverProbeProfiles({ tempRoot: root })).toEqual({
        removed: [old],
        failed: [],
      });
      expect(existsSync(old)).toBe(false);
      expect(existsSync(young)).toBe(true);
      expect(existsSync(other)).toBe(true);
      expect(adminAlert).not.toHaveBeenCalled();

      await utimes(young, hourAgo, hourAgo);
      expect(
        await removeLeftoverProbeProfiles({
          tempRoot: root,
          removeTempDir: async () => {
            throw new Error("EBUSY");
          },
        }),
      ).toEqual({ removed: [], failed: [young] });
      expect(adminAlert).toHaveBeenCalledTimes(1);
      expect(adminAlert.mock.calls[0][0]).toMatchObject({
        subject: "Project backup repository probe left credentials on disk",
        dedupBySubject: true,
      });
      expect(adminAlert.mock.calls[0][0].body).toContain(young);
      expect(adminAlert.mock.calls[0][0].body).not.toContain("s3-secret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("summarizes and classifies rustic errors", () => {
    const stderr =
      "\u001b[31merror:\u001b[0m rustic_core\nMessage:\nNo suitable key found for pw hunter2\n";
    expect(summarizeRusticError(stderr, ["hunter2"])).toBe(
      "No suitable key found for pw ***",
    );
    expect(classifyRusticError(stderr)).toBe("wrong_password");
    expect(classifyRusticError("connection reset by peer")).toBe("error");
  });

  it("probes active, sealed and draining repos once a day, and failing ones hourly", async () => {
    const good = await addRepo("active");
    const sealed = await addRepo("sealed");
    const draining = await addRepo("draining");
    const disabled = await addRepo("disabled");
    const broken = await addRepo("active");
    const passwords: Record<string, string> = {
      [good]: "good",
      [sealed]: "good",
      [draining]: "good",
      [disabled]: "good",
      [broken]: "bad",
    };
    let now = new Date("2026-10-26T12:00:00Z");
    const deps = {
      rusticPath,
      staggerMs: 0,
      now: () => now,
      loadToml: async (id: string) => toml(passwords[id]),
    };

    expect(await runProjectBackupRepoProbes(deps)).toEqual({
      probed: 4,
      failed: 1,
    });
    const { rows } = await getPool().query(
      "SELECT repo_id, last_result, last_error_kind, consecutive_failures FROM project_backup_repo_probes",
    );
    expect(rows.map((r) => r.repo_id).sort()).toEqual(
      [good, sealed, draining, broken].sort(),
    );
    expect(rows.find((r) => r.repo_id === broken)).toMatchObject({
      last_result: "failed",
      last_error_kind: "wrong_password",
      consecutive_failures: 1,
    });

    // Nothing is due right away.
    expect(await runProjectBackupRepoProbes(deps)).toEqual({
      probed: 0,
      failed: 0,
    });

    // An hour later only the failing repository is probed again.
    now = new Date("2026-10-26T13:00:01Z");
    expect(await runProjectBackupRepoProbes(deps)).toEqual({
      probed: 1,
      failed: 1,
    });

    // Fixed: it recovers, and its failure streak resets.
    passwords[broken] = "good";
    now = new Date("2026-10-26T14:00:02Z");
    expect(await runProjectBackupRepoProbes(deps)).toEqual({
      probed: 1,
      failed: 0,
    });
    const after = await getPool().query(
      "SELECT last_result, failing_since, consecutive_failures, last_ok_at FROM project_backup_repo_probes WHERE repo_id=$1",
      [broken],
    );
    expect(after.rows[0]).toMatchObject({
      last_result: "ok",
      failing_since: null,
      consecutive_failures: 0,
    });
    expect(after.rows[0].last_ok_at).not.toBeNull();

    // A day after the last probes everything is due again.
    now = new Date("2026-10-27T13:30:00Z");
    expect((await runProjectBackupRepoProbes(deps)).probed).toBe(4);
    expect((await calls()).join("\n")).not.toMatch(/\binit\b/);
  });

  it("rates deterministic, repeated, transient and stale problems", async () => {
    const now = new Date("2026-10-26T12:00:00Z");
    const deps = { rusticPath, staggerMs: 0, now: () => now };

    // A new repository has two days for its first probe.
    await addRepo("active", new Date("2026-10-26T11:00:00Z"));
    let health = await getProjectBackupRepoHealth({ now });
    expect(projectBackupRepoHealthLevel(health)).toBe("healthy");
    expect(health).toMatchObject({ repos: 1, never_probed: 1, problems: [] });
    // ... and is not described as verified before then.
    expect(projectBackupRepoHealthSummary(health)).toBe(
      "0 of 1 shared project backup repositories open with their stored secret; 1 new one has not been probed yet.",
    );

    // A single network error is a warning ...
    const flaky = await addRepo("active");
    await runProjectBackupRepoProbes({
      ...deps,
      loadToml: async (id) => toml(id === flaky ? "other" : "good"),
    });
    // (the fake reports a missing config for "other": make it transient)
    await getPool().query(
      "UPDATE project_backup_repo_probes SET last_error_kind='error' WHERE repo_id=$1",
      [flaky],
    );
    health = await getProjectBackupRepoHealth({ now });
    expect(projectBackupRepoHealthLevel(health)).toBe("warning");

    // ... twice in a row is critical.
    await getPool().query(
      "UPDATE project_backup_repo_probes SET consecutive_failures=2 WHERE repo_id=$1",
      [flaky],
    );
    health = await getProjectBackupRepoHealth({ now });
    expect(projectBackupRepoHealthLevel(health)).toBe("critical");
    expect(projectBackupRepoHealthSummary(health)).toContain(
      "1 shared project backup repository fails the health probe",
    );

    // So is a probe profile left on disk, even once.
    await getPool().query(
      "UPDATE project_backup_repo_probes SET consecutive_failures=1, last_error_kind='cleanup_failed' WHERE repo_id=$1",
      [flaky],
    );
    health = await getProjectBackupRepoHealth({ now });
    expect(projectBackupRepoHealthLevel(health)).toBe("critical");

    // A wrong password is critical at once.
    await getPool().query("DELETE FROM project_backup_repos WHERE id=$1", [
      flaky,
    ]);
    const bad = await addRepo("sealed");
    await runProjectBackupRepoProbes({
      ...deps,
      loadToml: async (id) => toml(id === bad ? "bad" : "good"),
    });
    health = await getProjectBackupRepoHealth({ now });
    expect(projectBackupRepoHealthLevel(health)).toBe("critical");
    expect(health.problems).toEqual([
      expect.objectContaining({
        repo_id: bad,
        problem: "failing",
        error_kind: "wrong_password",
        critical: true,
      }),
    ]);

    // Not probed for over two days (the probe stopped running) is critical.
    await getPool().query("DELETE FROM project_backup_repos WHERE id=$1", [
      bad,
    ]);
    await getPool().query(
      "UPDATE project_backup_repo_probes SET last_probe_at = $1",
      [new Date("2026-10-24T11:00:00Z")],
    );
    health = await getProjectBackupRepoHealth({ now });
    expect(projectBackupRepoHealthLevel(health)).toBe("critical");
    expect(health.problems.map((p) => p.problem)).toEqual(["stale"]);
    expect(projectBackupRepoHealthSummary(health)).toContain(
      "not been probed for over two days",
    );
  });

  it("shows the last probe in the shard admin status", async () => {
    const good = await addRepo("active");
    const bad = await addRepo("active");
    await runProjectBackupRepoProbes({
      rusticPath,
      staggerMs: 0,
      loadToml: async (id) => toml(id === bad ? "bad" : "good"),
    });
    const fresh = await addRepo("active");
    const status = await getProjectBackupShardAdminStatus();
    const byId = new Map(status.repos.map((repo) => [repo.id, repo]));
    expect(byId.get(good)?.probe).toMatchObject({
      result: "ok",
      last_probe_at: expect.any(String),
      last_ok_at: expect.any(String),
      consecutive_failures: 0,
    });
    expect(byId.get(bad)?.probe).toMatchObject({
      result: "failed",
      error_kind: "wrong_password",
      failing_since: expect.any(String),
      consecutive_failures: 1,
    });
    expect(byId.get(fresh)?.probe).toBeNull();
    // One row per repository, whatever the join.
    expect(status.repos).toHaveLength(3);
  });

  it("alerts admins when a repository fails, without secrets", async () => {
    const bad = await addRepo("active");
    await runProjectBackupRepoHealthCheck({
      rusticPath,
      staggerMs: 0,
      loadToml: async () => toml("bad"),
    });
    expect(adminAlert).toHaveBeenCalledTimes(1);
    const alert = adminAlert.mock.calls[0][0];
    expect(alert).toMatchObject({
      subject: "Project backup repository health probe failing",
      dedupBySubject: true,
    });
    expect(alert.body).toContain(bad);
    expect(alert.body).toContain("wrong_password");
    expect(alert.body).not.toContain("s3-secret");

    // Probing itself fails (here: the clock), and the repository has gone
    // unprobed for days: the alert still goes out.
    adminAlert.mockReset();
    await getPool().query(
      "UPDATE project_backup_repo_probes SET last_result='ok', last_probe_at = NOW() - INTERVAL '3 days'",
    );
    let first = true;
    await expect(
      runProjectBackupRepoHealthCheck({
        rusticPath,
        staggerMs: 0,
        loadToml: async () => toml("good"),
        now: () => {
          if (first) {
            first = false;
            throw new Error("probe run failed");
          }
          return new Date();
        },
      }),
    ).rejects.toThrow("probe run failed");
    expect(adminAlert).toHaveBeenCalledTimes(1);
    expect(adminAlert.mock.calls[0][0].body).toContain("last probed");

    adminAlert.mockReset();
    await getPool().query("DELETE FROM project_backup_repos");
    await addRepo("active");
    await runProjectBackupRepoHealthCheck({
      rusticPath,
      staggerMs: 0,
      loadToml: async () => toml("good"),
    });
    expect(adminAlert).not.toHaveBeenCalled();
  });
});
