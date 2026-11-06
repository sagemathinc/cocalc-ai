/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const queryMock = jest.fn();
const conditionAlertMock = jest.fn(async () => undefined);
const conditionClearedMock = jest.fn(async () => undefined);

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: queryMock }),
  withSessionAdvisoryLock: async ({ fn }) => await fn(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
jest.mock("@cocalc/server/hosts/condition-alert", () => ({
  ...jest.requireActual("@cocalc/server/hosts/condition-alert"),
  conditionAlert: (...args) => conditionAlertMock(...args),
  conditionCleared: (...args) => conditionClearedMock(...args),
}));

import {
  hostIntegrityHealth,
  runHostIntegrityAlertPass,
  summarizeHostIntegrity,
  type HostIntegrityRow,
} from "./host-integrity-health";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const finding = (extra = {}) => ({
  rule: "project-uid-outside-container",
  severity: "critical",
  comm: "sh",
  exe: "/usr/bin/dash",
  uids: [231072, 231072, 231072, 231072],
  userns: "host",
  parents: ["conmon", "systemd"],
  first_seen: ago(5 * 60_000),
  last_seen: ago(60_000),
  count: 30,
  ...extra,
});

const host = (
  id: string,
  integrity: Partial<HostIntegrityRow["integrity"]> | null,
): HostIntegrityRow => ({
  id,
  name: `host-${id}`,
  integrity:
    integrity == null
      ? null
      : ({
          watcher: "running",
          observed_at: ago(0),
          findings: [],
          config_changes: [],
          reboot_required_since: null,
          ...integrity,
        } as any),
});

describe("project host integrity health", () => {
  it("is healthy when every reporting host is clean, and counts unreported hosts", () => {
    const summary = summarizeHostIntegrity(
      [host("a", {}), host("b", null)],
      NOW,
    );
    expect(summary).toMatchObject({
      active_hosts: 2,
      unreported_hosts: 1,
      conditions: [],
    });
    expect(
      hostIntegrityHealth({ status: "fulfilled", value: summary }),
    ).toMatchObject({ level: "healthy" });
  });

  it("ignores a report the host no longer sends (merged heartbeat metadata)", () => {
    const summary = summarizeHostIntegrity(
      [host("a", { findings: [finding()], observed_at: ago(30 * 60_000) })],
      NOW,
    );
    expect(summary).toMatchObject({
      unreported_hosts: 1,
      conditions: [],
      reporting_subjects: [],
    });
  });

  it("raises each condition: findings, config changes, a silent watcher, a long pending reboot", () => {
    const summary = summarizeHostIntegrity(
      [
        host("a", { findings: [finding()] }),
        host("b", {
          config_changes: [
            {
              path: "/etc/sudoers",
              first_seen: ago(3_600_000),
              last_seen: ago(60_000),
            },
          ],
        }),
        host("c", { watcher: "stale", heartbeat_at: ago(600_000) }),
        host("d", { reboot_required_since: ago(3 * 24 * 3_600_000) }),
        // a reboot pending for a day is normal (unattended upgrades)
        host("e", { reboot_required_since: ago(24 * 3_600_000) }),
        // a finding from yesterday is history, not a condition
        host("f", {
          findings: [finding({ last_seen: ago(2 * 24 * 3_600_000) })],
        }),
      ],
      NOW,
    );
    expect(
      summary.conditions.map(({ host_id, kind, level }) => [
        host_id,
        kind,
        level,
      ]),
    ).toEqual([
      ["a", "processes", "critical"],
      ["b", "config", "warning"],
      ["c", "watcher", "warning"],
      ["d", "reboot", "warning"],
    ]);
    const health = hostIntegrityHealth({ status: "fulfilled", value: summary });
    expect(health.level).toBe("critical");
    expect(health.summary).toContain("report-only");
    expect(health.details.join("\n")).toContain("/usr/bin/dash");
  });

  it("alerts only on current findings, with stable bodies", () => {
    const summary = summarizeHostIntegrity(
      [
        host("a", {
          findings: [
            finding({ last_seen: ago(3 * 3_600_000) }), // earlier today
          ],
        }),
      ],
      NOW,
    );
    // still shown in health ...
    expect(summary.conditions).toHaveLength(1);
    // ... but nothing current to alert
    expect(summary.conditions[0].facts).toEqual([]);
    const current = summarizeHostIntegrity(
      [host("a", { findings: [finding({ count: 31 })] })],
      NOW,
    );
    const later = summarizeHostIntegrity(
      [host("a", { findings: [finding({ count: 99, last_seen: ago(1000) })] })],
      NOW,
    );
    expect(current.conditions[0].facts).toEqual(later.conditions[0].facts);
  });

  it("takes the alert level from current findings", () => {
    const summary = summarizeHostIntegrity(
      [
        host("a", {
          findings: [
            finding({ last_seen: ago(3 * 3_600_000) }), // critical, earlier
            finding({
              rule: "unexpected-runtime-user-process",
              severity: "high",
              exe: "/usr/bin/curl",
              uids: [2000, 2000, 2000, 2000],
            }),
          ],
        }),
      ],
      NOW,
    );
    expect(summary.conditions[0]).toMatchObject({ level: "warning" });
    expect(summary.conditions[0].facts).toHaveLength(1);
    // with nothing current, health shows the day's level
    const history = summarizeHostIntegrity(
      [host("a", { findings: [finding({ last_seen: ago(3_600_000) })] })],
      NOW,
    );
    expect(history.conditions[0]).toMatchObject({ level: "critical" });
  });

  it("alerts on a config change while the file still differs, then keeps it as history", () => {
    const change = (last_seen: string) => ({
      path: "/etc/sudoers",
      first_seen: ago(3 * 3_600_000),
      last_seen,
    });
    const current = summarizeHostIntegrity(
      [host("a", { config_changes: [change(ago(60_000))] })],
      NOW,
    );
    expect(current.conditions[0].facts).toEqual([
      "host-a (a): /etc/sudoers changed",
    ]);
    // repaired, or accepted by a bootstrap rebaseline: no longer refreshed
    const repaired = summarizeHostIntegrity(
      [host("a", { config_changes: [change(ago(3_600_000))] })],
      NOW,
    );
    expect(repaired.conditions).toHaveLength(1);
    expect(repaired.conditions[0].facts).toEqual([]);
    const old = summarizeHostIntegrity(
      [host("a", { config_changes: [change(ago(2 * 24 * 3_600_000))] })],
      NOW,
    );
    expect(old.conditions).toEqual([]);
  });
});

describe("host integrity alert pass", () => {
  const saved = process.env.COCALC_HOST_INTEGRITY_ALERTS;
  beforeEach(() => {
    queryMock.mockReset();
    conditionAlertMock.mockClear();
    conditionClearedMock.mockClear();
    jest.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    jest.useRealTimers();
    if (saved == null) delete process.env.COCALC_HOST_INTEGRITY_ALERTS;
    else process.env.COCALC_HOST_INTEGRITY_ALERTS = saved;
  });

  const rows = [host("a", { findings: [finding()] })];
  const respond = (activeSubjects: string[]) =>
    queryMock.mockImplementation(async (sql: string) =>
      sql.includes("admin_alert_state")
        ? { rows: activeSubjects.map((subject) => ({ subject })) }
        : { rows },
    );

  it("is report-only by default: no admin alert, and nothing cleared", async () => {
    delete process.env.COCALC_HOST_INTEGRITY_ALERTS;
    respond(["Host integrity: a: watcher not reporting"]);
    expect(await runHostIntegrityAlertPass()).toBe(1);
    expect(conditionAlertMock).not.toHaveBeenCalled();
    expect(conditionClearedMock).not.toHaveBeenCalled();
  });

  it("keys alert subjects on the host id, not its name", () => {
    const renamed = {
      ...host("a", { findings: [finding()] }),
      name: "renamed",
    };
    const summary = summarizeHostIntegrity([renamed], NOW);
    expect(summary.conditions[0].subject).toBe(
      "Host integrity: a: unexpected process placement",
    );
    expect(summary.conditions[0].facts[0]).toContain("renamed (a)");
  });

  it("alerts when enabled, and clears conditions a reporting host no longer shows", async () => {
    process.env.COCALC_HOST_INTEGRITY_ALERTS = "alert";
    respond([
      "Host integrity: a: watcher not reporting",
      // host-z went offline after its alert: the alert stays
      "Host integrity: z: unexpected process placement",
    ]);
    await runHostIntegrityAlertPass();
    expect(conditionAlertMock).toHaveBeenCalledTimes(1);
    const [{ subject, body }] = conditionAlertMock.mock.calls[0] as any;
    expect(subject).toBe("Host integrity: a: unexpected process placement");
    expect(body).toContain(
      "project-uid-outside-container: /usr/bin/dash uid 231072",
    );
    expect(conditionClearedMock.mock.calls).toEqual([
      ["Host integrity: a: watcher not reporting"],
    ]);
  });
});

describe("project runtime uid mode health", () => {
  // with a watcher in the matching mode (its comparison is tested below)
  const withMode = (id: string, mode: any): HostIntegrityRow => ({
    ...host(id, {
      detection: {
        runtime_uid_mode:
          mode?.effective === "separate" ? "separate" : "keep-id",
        exec_monitor: {
          state: "available",
          marked: 1,
          lost: 0,
          unattributed: 0,
        },
      },
    }),
    runtime_uid_mode: mode,
  });
  const report = (extra: any = {}) => ({
    configured: "keep-id",
    effective: "keep-id",
    label: "keep-id",
    reported_at: ago(0),
    ...extra,
  });
  const kinds = (rows: HostIntegrityRow[]) =>
    summarizeHostIntegrity(rows, NOW).conditions.map((c) => c.kind);

  it("alerts when separate is configured but projects start as keep-id, for every reason", () => {
    for (const reason of [
      "helper-old",
      "map-missing-block",
      "map-unparsable",
      "map-collision",
      "host-unsafe",
      "mode-invalid",
    ]) {
      const summary = summarizeHostIntegrity(
        [
          withMode(
            "a",
            report({
              configured: "separate",
              reason,
              label: `keep-id (fallback: ${reason})`,
            }),
          ),
        ],
        NOW,
      );
      const fallback = summary.conditions.filter(
        (c) => c.kind === "runtime-uid-fallback",
      );
      expect(fallback).toHaveLength(1);
      expect(fallback[0].level).toBe("warning");
      // alerted (current facts), with the reason
      expect(fallback[0].facts.join("\n")).toContain(`reason: ${reason}`);
      expect(summary.runtime_uid_modes).toEqual({
        [`keep-id (fallback: ${reason})`]: 1,
      });
    }
  });

  it("(control) no alert for keep-id as configured, or separate in effect", () => {
    expect(kinds([withMode("a", report())])).toEqual([]);
    expect(
      kinds([
        withMode(
          "b",
          report({
            configured: "separate",
            effective: "separate",
            label: "separate (partial)",
          }),
        ),
      ]),
    ).toEqual([]);
  });

  it("shows partial as partial (never plain separate), and undecided as undecided", () => {
    const summary = summarizeHostIntegrity(
      [
        withMode(
          "a",
          report({
            configured: "separate",
            effective: "separate",
            label: "separate (partial)",
          }),
        ),
        withMode(
          "b",
          report({
            configured: "separate",
            effective: "undecided",
            label: "undecided",
          }),
        ),
        withMode("c", report({ effective: "undecided", label: "undecided" })),
      ],
      NOW,
    );
    expect(summary.runtime_uid_modes).toEqual({
      "separate (partial)": 1,
      "undecided (configured separate)": 1,
      undecided: 1,
    });
    // undecided is never an alert, and never counted as a mode
    expect(summary.conditions).toEqual([]);
    const health = hostIntegrityHealth({ status: "fulfilled", value: summary });
    expect(health.details.join("\n")).toContain(
      "Runtime uid mode: 1 separate (partial), 1 undecided, 1 undecided (configured separate)",
    );
    expect(health.details.join("\n")).toContain(
      "the project user is not yet fully separated",
    );
  });

  it("a fallback label from the host can't hide the fallback", () => {
    // the comparison is configured vs effective, not the host's label
    const summary = summarizeHostIntegrity(
      [
        withMode(
          "a",
          report({
            configured: "separate",
            label: "keep-id",
            reason: "host-unsafe",
          }),
        ),
      ],
      NOW,
    );
    expect(summary.conditions.map((c) => c.kind)).toEqual([
      "runtime-uid-fallback",
    ]);
    expect(summary.runtime_uid_modes).toEqual({
      "keep-id (fallback: host-unsafe)": 1,
    });
  });

  it("reports the daemon state directory not being private after a separate start", () => {
    const summary = summarizeHostIntegrity(
      [
        withMode(
          "a",
          report({
            configured: "separate",
            effective: "separate",
            label: "separate (partial)",
            daemon_state: { ok: false, problem: "mode 0711", restored: true },
          }),
        ),
        withMode(
          "b",
          report({
            configured: "separate",
            effective: "separate",
            label: "separate (partial)",
            daemon_state: { ok: true },
          }),
        ),
      ],
      NOW,
    );
    const state = summary.conditions.filter((c) => c.kind === "daemon-state");
    expect(state).toHaveLength(1);
    expect(state[0].host_id).toBe("a");
    expect(state[0].facts[0]).toContain("mode 0711");
    expect(state[0].facts[0]).toContain("restored");
  });

  it("ignores stale and malformed reports (merged heartbeat metadata)", () => {
    const summary = summarizeHostIntegrity(
      [
        withMode(
          "a",
          report({ configured: "separate", reported_at: ago(60 * 60_000) }),
        ),
        withMode("b", { configured: "separate", effective: "nonsense" }),
        withMode("c", "separate"),
        host("d", {}),
      ],
      NOW,
    );
    expect(summary.conditions).toEqual([]);
    expect(summary.runtime_uid_modes).toEqual({ unreported: 4 });
  });

  it("never takes the host's label: a host claiming plain separate is shown as partial", () => {
    const summary = summarizeHostIntegrity(
      [
        withMode(
          "a",
          report({
            configured: "separate",
            effective: "separate",
            label: "separate",
          }),
        ),
        withMode(
          "b",
          report({
            configured: "separate",
            reason: "helper-old",
            label: "keep-id",
          }),
        ),
      ],
      NOW,
    );
    expect(summary.runtime_uid_modes).toEqual({
      "separate (partial)": 1,
      "keep-id (fallback: helper-old)": 1,
    });
  });

  it("alerts for a misspelled configured mode that falls back to keep-id", () => {
    const summary = summarizeHostIntegrity(
      [
        withMode(
          "a",
          report({
            configured: "seperate",
            reason: "mode-invalid",
            label: "keep-id (fallback: mode-invalid)",
          }),
        ),
      ],
      NOW,
    );
    const fallback = summary.conditions.filter(
      (c) => c.kind === "runtime-uid-fallback",
    );
    expect(fallback).toHaveLength(1);
    expect(fallback[0].facts[0]).toContain("seperate");
    expect(fallback[0].facts[0]).toContain("reason: mode-invalid");
  });

  it("counts a complete report with an unknown effective mode, or without a label, as unreported", () => {
    const summary = summarizeHostIntegrity(
      [
        withMode("a", report({ configured: "separate", effective: "garbage" })),
        withMode("b", {
          ...report({ configured: "separate" }),
          label: undefined,
        }),
      ],
      NOW,
    );
    expect(summary.conditions).toEqual([]);
    expect(summary.runtime_uid_modes).toEqual({ unreported: 2 });
    // not reporting: a fallback alert from before is not cleared by it
    expect(
      summary.reporting_subjects.filter(
        (s) => s.includes("runtime uid") || s.includes("daemon state"),
      ),
    ).toEqual([]);
  });

  it("treats a report stamped well in the future as stale (host clock ahead)", () => {
    const ahead = summarizeHostIntegrity(
      [
        withMode(
          "a",
          report({ configured: "separate", reported_at: ago(-60 * 60_000) }),
        ),
      ],
      NOW,
    );
    expect(ahead.conditions).toEqual([]);
    expect(ahead.runtime_uid_modes).toEqual({ unreported: 1 });
    // control: a little ahead (ordinary skew) still counts
    const skew = summarizeHostIntegrity(
      [
        withMode(
          "a",
          report({ configured: "separate", reported_at: ago(-60_000) }),
        ),
      ],
      NOW,
    );
    expect(skew.conditions.map((c) => c.kind)).toEqual([
      "runtime-uid-fallback",
    ]);
  });

  it("clears a fallback alert once the host reports separate in effect", async () => {
    // reporting_subjects lets the alert pass clear it
    const summary = summarizeHostIntegrity(
      [
        withMode(
          "a",
          report({
            configured: "separate",
            effective: "separate",
            label: "separate (partial)",
          }),
        ),
      ],
      NOW,
    );
    expect(summary.reporting_subjects).toContain(
      "Host integrity: a: separate runtime uid not in effect",
    );
  });
});

describe("integrity watcher detection settings", () => {
  const modeReport = (extra: any = {}) => ({
    configured: "separate",
    effective: "separate",
    label: "separate (partial)",
    reported_at: ago(0),
    ...extra,
  });
  const detection = (extra: any = {}) => ({
    runtime_uid_mode: "separate",
    runtime_user_in_container: "partial",
    exec_monitor: { state: "available", marked: 40, lost: 0, unattributed: 0 },
    ranges_state: "ok",
    layout_problems: 0,
    ...extra,
  });
  const row = (id: string, mode: any, det: any): HostIntegrityRow => ({
    ...host(id, det === undefined ? {} : { detection: det }),
    runtime_uid_mode: mode,
  });
  const watcherMode = (rows: HostIntegrityRow[]) =>
    summarizeHostIntegrity(rows, NOW).conditions.filter(
      (c) => c.kind === "watcher-mode",
    );

  it("raises a condition when projects start separate but the watcher runs in keep-id mode", () => {
    const found = watcherMode([
      row(
        "a",
        modeReport(),
        detection({
          runtime_uid_mode: "keep-id",
          exec_monitor: { state: "off", marked: 0, lost: 0, unattributed: 0 },
        }),
      ),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].level).toBe("warning");
    expect(found[0].facts[0]).toContain("runs in keep-id mode");
  });

  it("raises it when the watcher doesn't report its mode at all", () => {
    const found = watcherMode([row("a", modeReport(), undefined)]);
    expect(found).toHaveLength(1);
    expect(found[0].facts[0]).toContain("runs in unreported mode");
  });

  it("raises it when projects start separate and the exec monitor isn't available", () => {
    for (const state of [
      "degraded",
      "unavailable: Operation not permitted",
      "off",
    ]) {
      const found = watcherMode([
        row(
          "a",
          modeReport(),
          detection({
            exec_monitor: { state, marked: 0, lost: 1, unattributed: 0 },
          }),
        ),
      ]);
      expect(found).toHaveLength(1);
      expect(found[0].facts[0]).toContain(`exec monitor is ${state}`);
    }
  });

  it("raises it when the watcher runs separate on a host configured keep-id", () => {
    const found = watcherMode([
      row(
        "a",
        modeReport({
          configured: "keep-id",
          effective: "keep-id",
          label: "keep-id",
        }),
        detection(),
      ),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].facts[0]).toContain("but keep-id is configured");
  });

  it("(controls) nothing when they agree, while starting, on a fallback, or while undecided", () => {
    expect(watcherMode([row("a", modeReport(), detection())])).toEqual([]);
    expect(
      watcherMode([
        row(
          "a",
          modeReport(),
          detection({
            exec_monitor: {
              state: "starting",
              marked: 0,
              lost: 0,
              unattributed: 0,
            },
          }),
        ),
      ]),
    ).toEqual([]);
    // configured separate, fell back to keep-id: the fallback alert covers it
    expect(
      watcherMode([
        row(
          "a",
          modeReport({
            effective: "keep-id",
            reason: "host-unsafe",
            label: "keep-id (fallback: host-unsafe)",
          }),
          detection(),
        ),
      ]),
    ).toEqual([]);
    expect(
      watcherMode([
        row(
          "a",
          modeReport({ effective: "undecided", label: "undecided" }),
          detection({ runtime_uid_mode: "keep-id" }),
        ),
      ]),
    ).toEqual([]);
    // keep-id everywhere
    expect(
      watcherMode([
        row(
          "a",
          modeReport({
            configured: "keep-id",
            effective: "keep-id",
            label: "keep-id",
          }),
          detection({ runtime_uid_mode: "keep-id" }),
        ),
      ]),
    ).toEqual([]);
  });

  it("raises it for a keep-id configuration with a separate watcher, decided or not", () => {
    // undecided, configured keep-id, but the watcher runs separate: still a
    // mismatch of configuration
    expect(
      watcherMode([
        row(
          "a",
          modeReport({
            configured: "keep-id",
            effective: "undecided",
            label: "undecided",
          }),
          detection(),
        ),
      ]),
    ).toHaveLength(1);
  });

  it("compares only fresh reports, and only then lets the alert clear", () => {
    const stale = row(
      "a",
      modeReport({ reported_at: ago(60 * 60_000) }),
      detection({ runtime_uid_mode: "keep-id" }),
    );
    const summary = summarizeHostIntegrity([stale], NOW);
    expect(summary.conditions.filter((c) => c.kind === "watcher-mode")).toEqual(
      [],
    );
    expect(summary.reporting_subjects).not.toContain(
      "Host integrity: a: integrity watcher mode differs",
    );
    const fresh = summarizeHostIntegrity(
      [row("a", modeReport(), detection())],
      NOW,
    );
    expect(fresh.reporting_subjects).toContain(
      "Host integrity: a: integrity watcher mode differs",
    );
  });

  it("names the uid class and unreadable facts of a finding", () => {
    const summary = summarizeHostIntegrity(
      [
        host("a", {
          findings: [
            finding({
              uid_class: "project-runtime",
              unreadable: ["cgroup", "root"],
              uids: [1073741824],
            }),
          ],
        }),
      ],
      NOW,
    );
    const processes = summary.conditions.find((c) => c.kind === "processes")!;
    expect(processes.facts[0]).toContain("uid 1073741824 [project-runtime]");
    expect(processes.facts[0]).toContain("; unreadable: cgroup,root");
    // an older watcher's finding reads as before
    const old = summarizeHostIntegrity(
      [host("b", { findings: [finding()] })],
      NOW,
    );
    expect(old.conditions[0].facts[0]).not.toContain("[");
    expect(old.conditions[0].facts[0]).not.toContain("unreadable");
  });

  it("counts exec monitor states and layout mismatches for health", () => {
    const summary = summarizeHostIntegrity(
      [
        row("a", undefined, detection()),
        row(
          "b",
          undefined,
          detection({
            exec_monitor: { state: "off", marked: 0, lost: 0, unattributed: 0 },
            layout_problems: 12,
          }),
        ),
        row("c", undefined, undefined),
      ],
      NOW,
    );
    expect(summary.exec_monitor_states).toEqual({
      available: 1,
      off: 1,
      unreported: 1,
    });
    expect(summary.layout_mismatch_hosts).toBe(1);
    const health = hostIntegrityHealth({ status: "fulfilled", value: summary });
    expect(health.details).toContain(
      "Exec monitor: 1 available, 1 off, 1 unreported",
    );
    expect(health.details).toContain(
      "Project data layout: mismatches counted on 1 host",
    );
    // keep-id everywhere (monitors off or unreported): no exec monitor line
    const quiet = summarizeHostIntegrity(
      [
        row(
          "b",
          undefined,
          detection({
            exec_monitor: { state: "off", marked: 0, lost: 0, unattributed: 0 },
          }),
        ),
        row("c", undefined, undefined),
      ],
      NOW,
    );
    expect(
      hostIntegrityHealth({ status: "fulfilled", value: quiet }).details.some(
        (d) => d.startsWith("Exec monitor"),
      ),
    ).toBe(false);
  });
});
