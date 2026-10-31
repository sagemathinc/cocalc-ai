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
});
