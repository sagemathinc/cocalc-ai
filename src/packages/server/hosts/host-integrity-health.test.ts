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
  const withMode = (id: string, mode: any): HostIntegrityRow => ({
    ...host(id, {}),
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
