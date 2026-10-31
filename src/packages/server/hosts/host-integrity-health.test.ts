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
    expect(summary).toEqual({
      active_hosts: 2,
      unreported_hosts: 1,
      conditions: [],
    });
    expect(
      hostIntegrityHealth({ status: "fulfilled", value: summary }),
    ).toMatchObject({ level: "healthy" });
  });

  it("raises each condition: findings, config changes, a silent watcher, a long pending reboot", () => {
    const summary = summarizeHostIntegrity(
      [
        host("a", { findings: [finding()] }),
        host("b", {
          config_changes: [
            { path: "/etc/sudoers", first_seen: ago(3_600_000) },
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

  it("is report-only by default: no admin alert", async () => {
    delete process.env.COCALC_HOST_INTEGRITY_ALERTS;
    respond([]);
    expect(await runHostIntegrityAlertPass()).toBe(1);
    expect(conditionAlertMock).not.toHaveBeenCalled();
  });

  it("alerts when enabled, and clears conditions that ended", async () => {
    process.env.COCALC_HOST_INTEGRITY_ALERTS = "alert";
    respond(["Host integrity: host-z: watcher not reporting"]);
    await runHostIntegrityAlertPass();
    expect(conditionAlertMock).toHaveBeenCalledTimes(1);
    const [{ subject, body }] = conditionAlertMock.mock.calls[0] as any;
    expect(subject).toBe(
      "Host integrity: host-a: unexpected process placement",
    );
    expect(body).toContain(
      "project-uid-outside-container: /usr/bin/dash uid 231072",
    );
    expect(conditionClearedMock).toHaveBeenCalledWith(
      "Host integrity: host-z: watcher not reporting",
    );
  });
});
