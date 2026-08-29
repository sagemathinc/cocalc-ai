/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import {
  _test,
  classifyHostAvailabilitySnapshot,
  ensureHostAvailabilitySchema,
} from "./availability";

describe("classifyHostAvailabilitySnapshot", () => {
  it("allows durable unobserved availability events", async () => {
    await ensureHostAvailabilitySchema();
    const id = "0f490467-90fe-4f06-a896-dd4c8ef1945a";
    const hostId = "12869982-da11-495e-9914-ee784ee8d5a8";
    await getPool().query(
      `INSERT INTO project_host_availability_events
         (id, host_id, started_at, state, planned, category, source)
       VALUES ($1, $2, NOW(), 'unobserved', FALSE, 'host_stale', 'test')`,
      [id, hostId],
    );
    const { rows } = await getPool().query(
      `SELECT state FROM project_host_availability_events WHERE id=$1`,
      [id],
    );
    expect(rows[0]?.state).toBe("unobserved");
    await getPool().query(
      `DELETE FROM project_host_availability_events WHERE id=$1`,
      [id],
    );
  });

  it("treats a healthy standard fallback host as online", () => {
    const observation = classifyHostAvailabilitySnapshot({
      id: "dab25958-64df-4bea-803b-77319d7839f6",
      status: "running",
      last_seen: new Date().toISOString(),
      metadata: {
        desired_state: "running",
        spot_recovery_state: {
          phase: "running_standard_fallback",
        },
      },
    });

    expect(observation.state).toBe("online");
    expect(observation.planned).toBe(false);
    expect(observation.category).toBe("unknown");
    expect(observation.summary).toBe("Host is online on standard fallback.");
  });

  it("treats a healthy fallback host as online while probing spot capacity", () => {
    const observation = classifyHostAvailabilitySnapshot({
      id: "dab25958-64df-4bea-803b-77319d7839f6",
      status: "running",
      last_seen: new Date().toISOString(),
      metadata: {
        desired_state: "running",
        spot_recovery_state: {
          phase: "probing_spot",
        },
      },
    });

    expect(observation.state).toBe("online");
    expect(observation.summary).toBe("Host is online on standard fallback.");
  });

  it("keeps active spot retry as recovering", () => {
    const observation = classifyHostAvailabilitySnapshot({
      id: "dab25958-64df-4bea-803b-77319d7839f6",
      status: "starting",
      metadata: {
        desired_state: "running",
        spot_recovery_state: {
          phase: "retrying_spot",
        },
      },
    });

    expect(observation.state).toBe("recovering");
    expect(observation.category).toBe("spot_interruption");
  });

  it("treats a running host with stale heartbeats as unobserved", () => {
    const observation = classifyHostAvailabilitySnapshot({
      id: "12869982-da11-495e-9914-ee784ee8d5a8",
      status: "running",
      last_seen: new Date(Date.now() - 11 * 60_000).toISOString(),
      metadata: {
        desired_state: "running",
      },
    });

    expect(observation.state).toBe("unobserved");
    expect(observation.planned).toBe(false);
    expect(observation.category).toBe("host_stale");
    expect(observation.summary).toContain("observation is stale");
  });

  it("does not degrade availability for the first synthetic failure", () => {
    const base = {
      id: "7b1fa6e1-032d-4e90-bd20-00568c67d5d0",
      status: "running",
      last_seen: new Date().toISOString(),
      metadata: {
        desired_state: "running",
        runtime_synthetic_probe: {
          status: "failed",
          consecutive_failures: 1,
          quarantined: false,
          error: "transient crun getcwd failure",
        },
      },
    };
    expect(classifyHostAvailabilitySnapshot(base).state).toBe("online");
    expect(
      classifyHostAvailabilitySnapshot({
        ...base,
        metadata: {
          ...base.metadata,
          runtime_synthetic_probe: {
            ...base.metadata.runtime_synthetic_probe,
            consecutive_failures: 2,
            quarantined: true,
          },
        },
      }).state,
    ).toBe("degraded");
  });

  it("treats a fresh heartbeat with a failed runtime probe as degraded", () => {
    const observation = classifyHostAvailabilitySnapshot({
      id: "7b1fa6e1-032d-4e90-bd20-00568c67d5d0",
      status: "running",
      last_seen: new Date().toISOString(),
      metadata: {
        desired_state: "running",
        runtime_health: {
          status: "degraded",
          ready: false,
          consecutive_failures: 3,
          error: "podman ps timed out",
        },
      },
    });

    expect(observation.state).toBe("degraded");
    expect(observation.planned).toBe(false);
    expect(observation.category).toBe("runtime_degraded");
    expect(observation.summary).toContain("podman ps timed out");
  });

  it("keeps a host online after one transient runtime failure", () => {
    const observation = classifyHostAvailabilitySnapshot({
      id: "7b1fa6e1-032d-4e90-bd20-00568c67d5d0",
      status: "running",
      last_seen: new Date().toISOString(),
      metadata: {
        runtime_health: {
          status: "degraded",
          ready: false,
          consecutive_failures: 1,
          error: "podman ps timed out",
        },
      },
    });

    expect(observation.state).toBe("online");
  });

  it("treats a fresh heartbeat with a starting runtime as recovering", () => {
    const observation = classifyHostAvailabilitySnapshot({
      id: "7b1fa6e1-032d-4e90-bd20-00568c67d5d0",
      status: "running",
      last_seen: new Date().toISOString(),
      metadata: {
        runtime_health: { status: "starting", ready: false },
      },
    });

    expect(observation.state).toBe("recovering");
    expect(observation.category).toBe("runtime_degraded");
  });

  it("classifies a quarantined public browser route separately", () => {
    const observation = classifyHostAvailabilitySnapshot({
      id: "7b1fa6e1-032d-4e90-bd20-00568c67d5d0",
      status: "running",
      last_seen: new Date().toISOString(),
      metadata: {
        runtime_health: { status: "ready", ready: true },
        public_route_probe: {
          status: "failed",
          quarantined: true,
          error: "CORS preflight returned HTTP 502",
        },
      },
    });

    expect(observation.state).toBe("degraded");
    expect(observation.planned).toBe(false);
    expect(observation.category).toBe("public_route_degraded");
    expect(observation.summary).toContain("CORS preflight returned HTTP 502");
  });

  it("formats running-but-stale host alert bodies", () => {
    expect(_test.formatStaleDuration(125 * 60_000)).toBe("2h5m");
    const body = _test.formatRunningStaleHostAlertBody([
      {
        id: "12869982-da11-495e-9914-ee784ee8d5a8",
        status: "running",
        stale_ms: 6 * 60_000,
        metadata: { name: "montreal-1" },
        public_url:
          "https://host-12869982-da11-495e-9914-ee784ee8d5a8.cocalc.ai",
      },
    ]);
    expect(body).toContain("montreal-1");
    expect(body).toContain("stale>=10m");
    expect(body).not.toContain("stale>=6m");
  });

  it("defers stale-heartbeat escalation while remediation can still work", () => {
    const now = Date.UTC(2026, 6, 20, 12, 0, 0);
    const base = {
      id: "12869982-da11-495e-9914-ee784ee8d5a8",
      status: "running",
      stale_ms: 6 * 60_000,
      metadata: {},
    };
    expect(_test.runningStaleEscalationSuppressionReason(base)).toBe(
      "automatic remediation grace period",
    );
    expect(
      _test.runningStaleEscalationSuppressionReason(
        { ...base, stale_ms: 12 * 60_000 },
        "host-reconcile-software",
      ),
    ).toBe("active host-reconcile-software operation");
    expect(
      _test.runningStaleEscalationSuppressionReason(
        {
          ...base,
          stale_ms: 12 * 60_000,
          metadata: {
            spot_recovery_state: {
              phase: "returning_to_spot",
              verification_started_at: new Date(now - 2 * 60_000).toISOString(),
            },
          },
        },
        undefined,
        now,
      ),
    ).toBe("active spot recovery phase returning_to_spot");
    expect(
      _test.runningStaleEscalationSuppressionReason(
        {
          ...base,
          stale_ms: 12 * 60_000,
          metadata: {
            bootstrap: {
              status: "pending",
              pending_at: new Date(now - 2 * 60_000).toISOString(),
            },
          },
        },
        undefined,
        now,
      ),
    ).toBe("active host bootstrap");
  });

  it("defers repair when a replacement Spot VM has no heartbeat yet", () => {
    const now = Date.UTC(2026, 7, 29, 3, 38, 18);
    const row = {
      id: "7bd699f8-e20b-4b13-9dfa-f7358f85544e",
      status: "running",
      last_seen: null,
      // SQL represents a NULL last_seen as age since the Unix epoch.
      stale_ms: now,
      metadata: {
        spot_recovery_state: {
          phase: "running_standard_fallback",
          outage_started_at: new Date(now - 67_000).toISOString(),
          fallback_started_at: new Date(now - 28_000).toISOString(),
        },
      },
    };

    expect(_test.runningStaleLifecycleSuppressionReason(row, now)).toBe(
      "active spot recovery phase running_standard_fallback",
    );
    expect(
      _test.runningStaleEscalationSuppressionReason(row, undefined, now),
    ).toBe("active spot recovery phase running_standard_fallback");
  });

  it("escalates a stale host after lifecycle suppression expires", () => {
    const now = Date.UTC(2026, 7, 29, 4, 10, 0);
    expect(
      _test.runningStaleEscalationSuppressionReason(
        {
          id: "12869982-da11-495e-9914-ee784ee8d5a8",
          status: "running",
          stale_ms: 31 * 60_000,
          metadata: {
            spot_recovery_state: {
              phase: "running_standard_fallback",
              fallback_started_at: new Date(now - 31 * 60_000).toISOString(),
            },
          },
        },
        undefined,
        now,
      ),
    ).toBeUndefined();
  });

  it("identifies host pressure states that need admin attention", () => {
    const row = _test.pressureAlertRow({
      id: "246d760c-c160-46ee-a749-08a623f39d5e",
      status: "running",
      metadata: {
        name: "asia-1",
        pressure: {
          zone: "emergency",
          last_action_status: "no_candidates",
          last_action_reason: "memory_available_bytes<=2147483648",
        },
      },
    });

    expect(row).toMatchObject({
      pressure_zone: "emergency",
      pressure_action_status: "no_candidates",
      pressure_reason: "memory_available_bytes<=2147483648",
    });
    expect(_test.formatHostPressureAlertBody([row!])).toContain("asia-1");
  });

  it("ignores stale host pressure actions when recent metrics are normal", () => {
    const now = 2_000_000;
    expect(
      _test.pressureAlertRow(
        {
          id: "99838afd-80f3-4e5b-96b8-7aff05ba9452",
          status: "running",
          metric_collected_at: new Date(now - 60_000),
          metric_memory_used_percent: 25.7,
          metric_running_project_count: 0,
          metadata: {
            name: "small-dedicated-host",
            pressure: {
              zone: "pressure",
              evaluated_at_ms: now - 60_000,
              last_action_status: "no_candidates",
              last_action_reason: "memory_used_percent>=80",
            },
          },
        },
        now,
      ),
    ).toBeUndefined();
  });

  it("keeps recent unresolved pressure actions when metrics still show pressure", () => {
    const now = 2_000_000;
    const row = _test.pressureAlertRow(
      {
        id: "pressure-host",
        status: "running",
        metric_collected_at: new Date(now - 60_000),
        metric_memory_used_percent: 86,
        metric_running_project_count: 0,
        metadata: {
          pressure: {
            zone: "pressure",
            evaluated_at_ms: now - 60_000,
            last_action_status: "no_candidates",
            last_action_reason: "memory_used_percent>=80",
          },
        },
      },
      now,
    );

    expect(row).toMatchObject({
      pressure_zone: "pressure",
      pressure_action_status: "no_candidates",
    });
  });

  it("classifies fresh root filesystem pressure", () => {
    const now = 2_000_000;
    const warning = _test.rootFilesystemAlertRow(
      {
        id: "root-warning-host",
        status: "running",
        metadata: { name: "los-angeles-1" },
        metric_collected_at: new Date(now - 30_000),
        root_disk_total_bytes: 25 * 1024 ** 3,
        root_disk_used_bytes: 21 * 1024 ** 3,
        root_disk_available_bytes: 4 * 1024 ** 3,
        root_disk_used_percent: 84,
      },
      now,
    );
    expect(warning).toMatchObject({
      root_filesystem_level: "warning",
      root_filesystem_reason: expect.stringContaining("84.0% used"),
    });

    const critical = _test.rootFilesystemAlertRow(
      {
        id: "root-critical-host",
        status: "running",
        metric_collected_at: new Date(now - 30_000),
        root_disk_used_bytes: 24 * 1024 ** 3,
        root_disk_available_bytes: 1024 ** 3,
      },
      now,
    );
    expect(critical).toMatchObject({
      root_filesystem_level: "critical",
      root_filesystem_reason: expect.stringContaining("1.00 GiB available"),
    });
    expect(
      _test.formatRootFilesystemAlertBody([warning!, critical!]),
    ).toContain("distinct from the project-data filesystem");
  });

  it("ignores healthy or stale root filesystem samples", () => {
    const now = 2_000_000;
    expect(
      _test.rootFilesystemAlertRow(
        {
          id: "healthy-root-host",
          status: "running",
          metric_collected_at: new Date(now - 30_000),
          root_disk_used_bytes: 15 * 1024 ** 3,
          root_disk_available_bytes: 10 * 1024 ** 3,
          root_disk_used_percent: 60,
        },
        now,
      ),
    ).toBeUndefined();
    expect(
      _test.rootFilesystemAlertRow(
        {
          id: "stale-root-host",
          status: "running",
          metric_collected_at: new Date(now - 10 * 60_000),
          root_disk_used_bytes: 24 * 1024 ** 3,
          root_disk_available_bytes: 1024 ** 3,
          root_disk_used_percent: 96,
        },
        now,
      ),
    ).toBeUndefined();
  });

  it("classifies project-host persistence RSS at the 2/4 GiB defaults", () => {
    const now = 2_000_000;
    const makeRow = (rss_bytes: number) =>
      _test.conatPersistAlertRow(
        {
          id: "persist-host",
          status: "running",
          metadata: { name: "asia-1" },
          conat_persist: {
            schema_version: 1,
            collected_at: new Date(now - 30_000).toISOString(),
            available: true,
            ready: true,
            pid: 123,
            rss_bytes,
            open_streams: 500,
          },
        },
        now,
      );

    expect(makeRow(1.5 * 1024 ** 3)).toBeUndefined();
    expect(makeRow(3 * 1024 ** 3)).toMatchObject({
      persist_level: "warning",
      persist_reason: expect.stringContaining("RSS 3.00 GiB >= 2.00 GiB"),
    });

    const row = makeRow(5 * 1024 ** 3);
    expect(row).toMatchObject({
      persist_level: "critical",
      persist_reason: expect.stringContaining("RSS 5.00 GiB >= 4.00 GiB"),
    });
    expect(_test.formatConatPersistAlertBody([row!])).toContain(
      "observational only",
    );
  });

  it("classifies excessive persistence stream cardinality independently of RSS", () => {
    const now = 2_000_000;
    expect(
      _test.conatPersistAlertRow(
        {
          id: "stream-heavy-host",
          status: "running",
          conat_persist: {
            schema_version: 1,
            collected_at: new Date(now - 30_000).toISOString(),
            available: true,
            rss_bytes: 200 * 1024 ** 2,
            open_streams: 2_500,
          },
        },
        now,
      ),
    ).toMatchObject({
      persist_level: "warning",
      persist_reason: expect.stringContaining("open streams 2500"),
    });
  });

  it("ignores stale or unavailable persistence diagnostics", () => {
    const now = 2_000_000;
    expect(
      _test.conatPersistAlertRow(
        {
          id: "stale-persist-host",
          status: "running",
          conat_persist: {
            schema_version: 1,
            collected_at: new Date(now - 10 * 60_000).toISOString(),
            available: true,
            rss_bytes: 3 * 1024 ** 3,
          },
        },
        now,
      ),
    ).toBeUndefined();
    expect(
      _test.conatPersistAlertRow(
        {
          id: "unavailable-persist-host",
          status: "running",
          conat_persist: {
            schema_version: 1,
            collected_at: new Date(now).toISOString(),
            available: false,
            rss_bytes: 3 * 1024 ** 3,
          },
        },
        now,
      ),
    ).toBeUndefined();
  });

  it("ignores old unresolved pressure evaluations", () => {
    const now = 2_000_000;
    expect(
      _test.pressureAlertRow(
        {
          id: "old-pressure-host",
          status: "running",
          metadata: {
            pressure: {
              zone: "pressure",
              evaluated_at_ms: now - 31 * 60_000,
              last_action_status: "no_candidates",
            },
          },
        },
        now,
      ),
    ).toBeUndefined();
  });

  it("ignores healthy pressure states", () => {
    expect(
      _test.pressureAlertRow({
        id: "healthy-host",
        status: "running",
        metadata: {
          pressure: {
            zone: "observe",
            last_action_status: "cooldown",
          },
        },
      }),
    ).toBeUndefined();
    expect(
      _test.pressureAlertRow({
        id: "normal-host",
        status: "running",
        metadata: {
          pressure: {
            zone: "normal",
          },
        },
      }),
    ).toBeUndefined();
  });

  it("keeps running-but-stale alert bodies stable as staleness grows", () => {
    expect(
      _test.formatRunningStaleHostAlertBody([
        {
          id: "12869982-da11-495e-9914-ee784ee8d5a8",
          status: "running",
          stale_ms: 6 * 60_000,
          metadata: { name: "montreal-1" },
          public_url:
            "https://host-12869982-da11-495e-9914-ee784ee8d5a8.cocalc.ai",
        },
      ]),
    ).toEqual(
      _test.formatRunningStaleHostAlertBody([
        {
          id: "12869982-da11-495e-9914-ee784ee8d5a8",
          status: "running",
          stale_ms: 90 * 60_000,
          metadata: { name: "montreal-1" },
          public_url:
            "https://host-12869982-da11-495e-9914-ee784ee8d5a8.cocalc.ai",
        },
      ]),
    );
  });
});
