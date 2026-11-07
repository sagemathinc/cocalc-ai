import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHostIntegrity } from "./host-integrity";

describe("host integrity for the heartbeat", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "host-integrity-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const now = Date.parse("2026-10-31T01:00:00Z");
  const status = (extra: Record<string, unknown> = {}) => ({
    schema: "cocalc-host-integrity-v1",
    started_at: "2026-10-31T00:00:00Z",
    heartbeat_at: "2026-10-31T00:59:50Z",
    scans: 1800,
    errors: 0,
    findings: [],
    config: { baseline_at: "2026-10-31T00:00:01Z", changes: [] },
    inventory: { "host|runtime|/usr/bin/sudo": 3 },
    ...extra,
  });

  it("reports a missing watcher without failing", async () => {
    const result = await readHostIntegrity({
      statusPath: join(dir, "absent.json"),
      rebootPath: join(dir, "reboot-required"),
      now,
    });
    expect(result).toEqual({
      watcher: "missing",
      observed_at: "2026-10-31T01:00:00.000Z",
      reboot_required_since: null,
    });
  });

  it("reports an unreadable status, and a stale one", async () => {
    await writeFile(join(dir, "broken.json"), "{");
    expect(
      (
        await readHostIntegrity({
          statusPath: join(dir, "broken.json"),
          rebootPath: join(dir, "none"),
          now,
        })
      ).watcher,
    ).toBe("unreadable");
    await writeFile(
      join(dir, "status.json"),
      JSON.stringify(status({ heartbeat_at: "2026-10-31T00:50:00Z" })),
    );
    expect(
      (
        await readHostIntegrity({
          statusPath: join(dir, "status.json"),
          rebootPath: join(dir, "none"),
          now,
        })
      ).watcher,
    ).toBe("stale");
  });

  it("passes on findings, trimmed to the fields and counts the bay needs", async () => {
    const findings = Array.from({ length: 30 }, (_, i) => ({
      rule: "unexpected-runtime-user-process",
      severity: "high",
      pid: 100 + i,
      comm: "curl",
      exe: "/usr/bin/curl",
      uids: [2000, 2000, 2000, 2000],
      userns: "host",
      parents: ["project-host:ap", "systemd"],
      cgroup: "/user.slice",
      first_seen: "2026-10-31T00:10:00Z",
      last_seen: "2026-10-31T00:59:00Z",
      count: 5,
      // anything else the file might hold is not passed on
      cmdline: "curl --label canary-in-cmdline",
    }));
    await writeFile(
      join(dir, "status.json"),
      JSON.stringify(
        status({
          findings,
          config: {
            baseline_at: "2026-10-31T00:00:01Z",
            changes: [
              {
                rule: "host-config-changed",
                path: "/etc/sudoers",
                first_seen: "2026-10-31T00:30:00Z",
              },
            ],
          },
        }),
      ),
    );
    await writeFile(
      join(dir, "reboot-required"),
      "*** System restart required ***\n",
    );
    const since = new Date("2026-10-28T12:00:00Z");
    await utimes(join(dir, "reboot-required"), since, since);
    const result = await readHostIntegrity({
      statusPath: join(dir, "status.json"),
      rebootPath: join(dir, "reboot-required"),
      now,
    });
    expect(result.watcher).toBe("running");
    // the exec monitor's start bound is measured from it
    expect(result.started_at).toBe("2026-10-31T00:00:00.000Z");
    expect(result.scans).toBe(1800);
    expect(result.finding_count).toBe(30);
    expect(result.findings).toHaveLength(20);
    expect(Object.keys(result.findings![0]).sort()).toEqual(
      [
        "comm",
        "count",
        "exe",
        "first_seen",
        "last_seen",
        "parents",
        "rule",
        "severity",
        "uids",
        "userns",
      ].sort(),
    );
    expect(JSON.stringify(result)).not.toContain("canary-in-cmdline");
    expect(result.config_changes).toEqual([
      {
        path: "/etc/sudoers",
        first_seen: "2026-10-31T00:30:00.000Z",
        last_seen: undefined,
      },
    ]);
    expect(result.inventory).toEqual({ "host|runtime|/usr/bin/sudo": 3 });
    expect(result.reboot_required_since).toBe("2026-10-28T12:00:00.000Z");
  });

  it("keeps critical findings when there are more than it passes on", async () => {
    const high = Array.from({ length: 25 }, (_, i) => ({
      rule: "unexpected-runtime-user-process",
      severity: "high",
      exe: `/usr/bin/tool-${i}`,
      last_seen: "2026-10-31T00:59:00Z",
    }));
    const critical = {
      rule: "project-uid-outside-container",
      severity: "critical",
      exe: "/usr/bin/dash",
      last_seen: "2026-10-31T00:59:00Z",
    };
    await writeFile(
      join(dir, "status.json"),
      JSON.stringify(status({ findings: [...high, critical] })),
    );
    const result = await readHostIntegrity({
      statusPath: join(dir, "status.json"),
      rebootPath: join(dir, "none"),
      now,
    });
    expect(result.finding_count).toBe(26);
    expect(result.findings).toHaveLength(20);
    expect(result.findings![0].severity).toBe("critical");
  });

  it("keeps the newest config changes when there are more than it passes on", async () => {
    // in the order the watcher first saw them; the last ones are the newest
    const changes = Array.from({ length: 25 }, (_, i) => ({
      rule: "host-config-changed",
      path: `/etc/cron.d/job-${i}`,
      first_seen: "2026-10-30T00:00:00Z",
      last_seen: new Date(
        Date.parse("2026-10-31T00:00:00Z") + i * 60_000,
      ).toISOString(),
    }));
    await writeFile(
      join(dir, "status.json"),
      JSON.stringify(
        status({ config: { baseline_at: "2026-10-30T00:00:00Z", changes } }),
      ),
    );
    const result = await readHostIntegrity({
      statusPath: join(dir, "status.json"),
      rebootPath: join(dir, "none"),
      now,
    });
    expect(result.config_change_count).toBe(25);
    expect(result.config_changes).toHaveLength(20);
    expect(result.config_changes![0].path).toBe("/etc/cron.d/job-24");
    expect(result.config_changes!.map((c) => c.path)).not.toContain(
      "/etc/cron.d/job-4",
    );
  });

  it("passes on the uid class and unreadable facts of a finding, sanitized", async () => {
    const finding = (extra: Record<string, unknown>) => ({
      rule: "project-uid-outside-container",
      severity: "critical",
      comm: "sh",
      exe: "/usr/bin/dash",
      uids: [1073741824],
      userns: "other",
      parents: [],
      last_seen: "2026-10-31T00:59:00Z",
      count: 1,
      ...extra,
    });
    await writeFile(
      join(dir, "status.json"),
      JSON.stringify(
        status({
          findings: [
            finding({
              uid_class: "project-runtime",
              unreadable: ["cgroup", "root"],
            }),
            // not a label, and names that aren't fact names: dropped
            finding({
              exe: "/usr/bin/other",
              uid_class: "x".repeat(100),
              unreadable: ["mntns", "../etc", 7, "A"],
            }),
            // an older watcher: neither field
            finding({ exe: "/usr/bin/old" }),
            finding({ exe: "mode", affected: 12 }),
            finding({ exe: "zero", affected: 0 }),
            finding({ exe: "negative", affected: -3 }),
            // more names than it passes on
            finding({
              exe: "/usr/bin/many",
              unreadable: Array.from({ length: 12 }, () => "cgroup"),
            }),
          ],
        }),
      ),
    );
    const result = await readHostIntegrity({
      statusPath: join(dir, "status.json"),
      rebootPath: join(dir, "none"),
      now,
    });
    const byExe = Object.fromEntries(result.findings!.map((f) => [f.exe, f]));
    expect(byExe["/usr/bin/dash"].uid_class).toBe("project-runtime");
    expect(byExe["/usr/bin/dash"].unreadable).toEqual(["cgroup", "root"]);
    expect(byExe["/usr/bin/other"].uid_class).toBeUndefined();
    expect(byExe["/usr/bin/other"].unreadable).toEqual(["mntns"]);
    expect(byExe["/usr/bin/many"].unreadable).toHaveLength(8);
    expect("uid_class" in byExe["/usr/bin/old"]).toBe(false);
    expect(byExe["mode"].affected).toBe(12);
    expect("affected" in byExe["zero"]).toBe(false);
    expect("affected" in byExe["negative"]).toBe(false);
    expect("affected" in byExe["/usr/bin/old"]).toBe(false);
    expect("unreadable" in byExe["/usr/bin/old"]).toBe(false);
  });

  it("reports what the watcher checks, and nothing for watchers that predate it", async () => {
    await writeFile(
      join(dir, "status.json"),
      JSON.stringify(
        status({
          runtime_uid_mode: "separate",
          rule2: "partial",
          rule3: {
            state: "degraded",
            marked: 42,
            lost_events: 2,
            malformed_records: 1,
            unattributed: {
              "/usr/bin/a": 3,
              "/usr/bin/b": 1,
              "relative/path": 5,
              "/usr/bin/x; y": 2,
            },
            truncated_mounts: ["/"],
          },
          ranges_state: "stale",
          hardening: {
            problems: {
              "project-homes": { mode: 12 },
              "data-root": { owner: 1 },
            },
          },
        }),
      ),
    );
    const result = await readHostIntegrity({
      statusPath: join(dir, "status.json"),
      rebootPath: join(dir, "none"),
      now,
    });
    expect(result.detection).toEqual({
      runtime_uid_mode: "separate",
      runtime_user_in_container: "partial",
      exec_monitor: {
        state: "degraded",
        marked: 42,
        lost: 3,
        unattributed: 11,
        // absolute plain paths only, the most frequent first
        unattributed_programs: { "/usr/bin/a": 3, "/usr/bin/b": 1 },
      },
      ranges_state: "stale",
      layout_problems: 13,
    });
    // an older watcher's status: no detection block at all
    await writeFile(join(dir, "old.json"), JSON.stringify(status()));
    const old = await readHostIntegrity({
      statusPath: join(dir, "old.json"),
      rebootPath: join(dir, "none"),
      now,
    });
    expect("detection" in old).toBe(false);
    // program counts: positive only, at most 10, the most frequent first
    await writeFile(
      join(dir, "many.json"),
      JSON.stringify(
        status({
          rule3: {
            state: "available",
            unattributed: {
              ...Object.fromEntries(
                Array.from({ length: 12 }, (_, i) => [`/usr/bin/p${i}`, i + 1]),
              ),
              "/usr/bin/zero": 0,
              "/usr/bin/negative": -4,
            },
          },
        }),
      ),
    );
    const many = await readHostIntegrity({
      statusPath: join(dir, "many.json"),
      rebootPath: join(dir, "none"),
      now,
    });
    const programs = many.detection!.exec_monitor!.unattributed_programs!;
    expect(Object.keys(programs)).toHaveLength(10);
    expect(Object.keys(programs)[0]).toBe("/usr/bin/p11");
    expect(programs["/usr/bin/zero"]).toBeUndefined();
    expect(programs["/usr/bin/negative"]).toBeUndefined();
    expect(programs["/usr/bin/p0"]).toBeUndefined();
    // and without the cap in play: zero and negative counts are dropped
    await writeFile(
      join(dir, "few.json"),
      JSON.stringify(
        status({
          rule3: {
            state: "available",
            unattributed: {
              "/usr/bin/a": 2,
              "/usr/bin/zero": 0,
              "/usr/bin/neg": -1,
            },
          },
        }),
      ),
    );
    const few = await readHostIntegrity({
      statusPath: join(dir, "few.json"),
      rebootPath: join(dir, "none"),
      now,
    });
    expect(few.detection!.exec_monitor!.unattributed_programs).toEqual({
      "/usr/bin/a": 2,
    });
    // numbers too large for a double parse to Infinity: never passed on
    await writeFile(
      join(dir, "huge.json"),
      JSON.stringify(
        status({
          findings: [
            {
              rule: "hardening-project-homes",
              severity: "high",
              comm: "project-homes",
              exe: "mode",
              uids: [],
              userns: "host",
              parents: [],
              last_seen: "2026-10-31T00:59:00Z",
              count: 1,
              affected: "HUGE",
            },
          ],
          rule3: {
            state: "available",
            marked: "HUGE",
            lost_events: "HUGE",
            unattributed: { "/usr/bin/a": "HUGE", "/usr/bin/b": 1 },
          },
        }),
      ).replace(/"HUGE"/g, "1e999"),
    );
    const huge = await readHostIntegrity({
      statusPath: join(dir, "huge.json"),
      rebootPath: join(dir, "none"),
      now,
    });
    expect(huge.detection!.exec_monitor).toEqual({
      state: "available",
      marked: 0,
      lost: 0,
      unattributed: 1,
      unattributed_programs: { "/usr/bin/b": 1 },
    });
    expect("affected" in huge.findings![0]).toBe(false);
    // finite values that add up past what a double holds: capped, not Infinity
    await writeFile(
      join(dir, "big.json"),
      JSON.stringify(
        status({
          rule3: {
            state: "available",
            lost_events: 1e308,
            malformed_records: 1e308,
            unattributed: { "/usr/bin/a": 1e308, "/usr/bin/b": 1e308 },
          },
          hardening: { problems: { a: { x: 1e308 }, b: { y: 1e308 } } },
        }),
      ),
    );
    const big = await readHostIntegrity({
      statusPath: join(dir, "big.json"),
      rebootPath: join(dir, "none"),
      now,
    });
    expect(big.detection!.exec_monitor!.lost).toBe(Number.MAX_SAFE_INTEGER);
    expect(big.detection!.exec_monitor!.unattributed).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(big.detection!.layout_problems).toBe(Number.MAX_SAFE_INTEGER);
    // values that aren't labels are dropped, never passed on as text
    await writeFile(
      join(dir, "odd.json"),
      JSON.stringify(
        status({
          runtime_uid_mode: "separate; rm -rf /",
          rule3: { state: { nested: true } },
        }),
      ),
    );
    const odd = await readHostIntegrity({
      statusPath: join(dir, "odd.json"),
      rebootPath: join(dir, "none"),
      now,
    });
    expect(odd.detection?.runtime_uid_mode).toBeUndefined();
    expect(odd.detection?.exec_monitor?.state).toBe("unknown");
  });
});
