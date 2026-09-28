/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { _test } from "./host-pressure";

const {
  buildStopCandidates,
  classifyHostPressure,
  directIoPressureOffenders,
  pressureStopStateUpdate,
  resourcePressureFindings,
} = _test;

describe("host pressure controller helpers", () => {
  it("classifies memory pressure zones", () => {
    expect(
      classifyHostPressure({
        memory_used_percent: 50,
        memory_available_bytes: 16 * 1024 ** 3,
      }),
    ).toMatchObject({ zone: "normal" });
    expect(
      classifyHostPressure({
        memory_used_percent: 76,
        memory_available_bytes: 32 * 1024 ** 3,
      }),
    ).toMatchObject({ zone: "observe" });
    expect(
      classifyHostPressure({
        memory_used_percent: 81,
        memory_available_bytes: 32 * 1024 ** 3,
      }),
    ).toMatchObject({ zone: "pressure" });
    expect(
      classifyHostPressure({
        memory_used_percent: 91,
        memory_available_bytes: 32 * 1024 ** 3,
      }),
    ).toMatchObject({ zone: "emergency" });
    expect(
      classifyHostPressure({
        memory_total_bytes: 64 * 1024 ** 3,
        memory_used_percent: 82,
        memory_available_bytes: 12 * 1024 ** 3,
      }),
    ).toMatchObject({ zone: "pressure" });
    expect(
      classifyHostPressure({
        memory_total_bytes: 64 * 1024 ** 3,
        memory_used_percent: 86,
        memory_available_bytes: 6 * 1024 ** 3,
      }),
    ).toMatchObject({ zone: "emergency" });
  });

  it("scales available-memory thresholds on small hosts", () => {
    const total = 8 * 1024 ** 3;
    expect(
      classifyHostPressure({
        memory_total_bytes: total,
        memory_used_percent: 39,
        memory_available_bytes: 5.1 * 1024 ** 3,
      }),
    ).toMatchObject({ zone: "normal" });
    expect(
      classifyHostPressure({
        memory_total_bytes: total,
        memory_used_percent: 82,
        memory_available_bytes: 1.4 * 1024 ** 3,
      }),
    ).toMatchObject({ zone: "pressure" });
    expect(
      classifyHostPressure({
        memory_total_bytes: total,
        memory_used_percent: 91,
        memory_available_bytes: 0.7 * 1024 ** 3,
      }),
    ).toMatchObject({ zone: "emergency" });
  });

  it("classifies resource pressure only when resource mode is enabled", () => {
    const metrics = {
      memory_used_percent: 20,
      memory_available_bytes: 16 * 1024 ** 3,
      kernel_sysctls: {
        targets: {
          "fs.inotify.max_user_instances": 8192,
          "fs.inotify.max_user_watches": 2_097_152,
        },
        values: {
          "fs.inotify.max_user_instances": 8192,
          "fs.inotify.max_user_watches": 2_097_152,
        },
        ok: true,
        mismatches: [],
      },
      resource_pressure: {
        running_project_count: 1,
        sampled_project_count: 1,
        fresh_project_count: 1,
        stale_project_count: 0,
        missing_project_count: 0,
        truncated_project_count: 0,
        error_project_count: 0,
        total_pids: 2,
        total_threads: 4,
        total_file_descriptors: 100,
        total_sockets: 10,
        total_inotify_instances: 1200,
        total_inotify_watches: 300_000,
        largest_inotify_instances: {
          project_id: "proj-watch",
          sampled_at_ms: 1,
          age_ms: 0,
          pids: 2,
          threads: 4,
          file_descriptors: 100,
          sockets: 10,
          inotify_instances: 1200,
          inotify_watches: 300_000,
        },
        largest_inotify_watches: {
          project_id: "proj-watch",
          sampled_at_ms: 1,
          age_ms: 0,
          pids: 2,
          threads: 4,
          file_descriptors: 100,
          sockets: 10,
          inotify_instances: 1200,
          inotify_watches: 300_000,
        },
      },
    };

    expect(classifyHostPressure(metrics, 1)).toMatchObject({
      zone: "normal",
    });
    expect(
      classifyHostPressure(metrics, 1, { resourcePressureMode: "signal" }),
    ).toMatchObject({
      zone: "pressure",
    });
    expect(
      resourcePressureFindings(metrics).directOffenders.get("proj-watch")
        ?.reason,
    ).toContain("resource_project_inotify");
  });

  it("requires sustained storage emergency before enforcing I/O pressure", () => {
    const now = Date.parse("2026-08-02T12:00:00.000Z");
    const metrics = {
      memory_used_percent: 20,
      memory_available_bytes: 32 * 1024 ** 3,
      storage_admission: {
        schema_version: 1 as const,
        collected_at: new Date(now).toISOString(),
        mode: "enforce" as const,
        pressure_state: "emergency" as const,
        state_since: new Date(now - 30_000).toISOString(),
        effective_io_full_avg10: 25,
        uncontained_io_full_avg10: 25,
        lifecycle_active: 0,
        starting_projects: 0,
        stopping_projects: 0,
        active_by_priority: {
          lifecycle: 0,
          interactive: 0,
          scheduled: 0,
          scavenger: 0,
        },
        btrfs_mutation_locks: 0,
        btrfs_mutation_waiters: 0,
        admitted_total: 0,
        deferred_total: 0,
        observed_deferral_total: 0,
        transition_count: 1,
      },
    };

    expect(
      classifyHostPressure(metrics, now, { ioPressureMode: "enforce" }),
    ).toMatchObject({ zone: "observe" });
    expect(
      classifyHostPressure(metrics, now, {
        ioPressureMode: "enforce",
        ioPressureSinceMs: now - 11 * 60_000,
      }),
    ).toMatchObject({ zone: "emergency" });
    metrics.storage_admission.state_since = new Date(
      now - 3 * 60_000,
    ).toISOString();
    expect(
      classifyHostPressure(metrics, now, { ioPressureMode: "enforce" }),
    ).toMatchObject({ zone: "pressure" });
    metrics.storage_admission.state_since = new Date(
      now - 11 * 60_000,
    ).toISOString();
    expect(
      classifyHostPressure(metrics, now, { ioPressureMode: "enforce" }),
    ).toMatchObject({ zone: "emergency" });
    expect(
      classifyHostPressure(metrics, now, { ioPressureMode: "metrics" }),
    ).toMatchObject({ zone: "normal" });
  });

  it("does not evict projects for pressure caused by project-pool throttling", () => {
    const now = Date.parse("2026-08-02T12:00:00.000Z");
    const metrics = {
      memory_used_percent: 20,
      memory_available_bytes: 32 * 1024 ** 3,
      storage_admission: {
        schema_version: 1 as const,
        collected_at: new Date(now).toISOString(),
        mode: "enforce" as const,
        pressure_state: "emergency" as const,
        state_since: new Date(now - 60 * 60_000).toISOString(),
        host_io_full_avg10: 45,
        project_pool_io_full_avg10: 60,
        effective_io_full_avg10: 60,
        uncontained_io_full_avg10: 0,
        lifecycle_active: 0,
        starting_projects: 0,
        stopping_projects: 0,
        active_by_priority: {
          lifecycle: 0,
          interactive: 0,
          scheduled: 0,
          scavenger: 0,
        },
        btrfs_mutation_locks: 0,
        btrfs_mutation_waiters: 0,
        admitted_total: 0,
        deferred_total: 0,
        observed_deferral_total: 0,
        transition_count: 1,
      },
    };

    expect(
      classifyHostPressure(metrics, now, {
        ioPressureMode: "enforce",
        ioPressureSinceMs: now - 60 * 60_000,
      }),
    ).toMatchObject({ zone: "observe" });

    const headroomMetrics = {
      ...metrics,
      io_containment: {
        collected_at: new Date(now).toISOString(),
        policy_mode: "enforce" as const,
        policy_profile: "gcp-pd-balanced-btrfs-headroom",
        mountpoint: "/mnt/cocalc",
        capability: "validated" as const,
        pool_cgroup: "/sys/fs/cgroup/cocalc-project-pool",
        devices: [],
        top_projects: [],
        sampled_project_count: 0,
        total_project_count: 0,
        stale_project_count: 0,
        truncated: false,
      },
    };
    expect(
      classifyHostPressure(headroomMetrics, now, {
        ioPressureMode: "enforce",
        ioPressureSinceMs: now - 60 * 60_000,
      }),
    ).toMatchObject({ zone: "emergency" });
  });

  it("attributes direct I/O pressure to the stalling project", () => {
    const offenders = directIoPressureOffenders(
      new Map([
        [
          "busy",
          {
            cpu_cores: 0.2,
            io_bytes_per_second: 9 * 1024 * 1024,
            io_operations_per_second: 300,
            io_full_pressure_percent: 63.5,
          },
        ],
        [
          "healthy",
          {
            cpu_cores: 0.2,
            io_bytes_per_second: 20 * 1024 * 1024,
            io_operations_per_second: 500,
            io_full_pressure_percent: 2,
          },
        ],
      ]),
      25,
    );
    expect([...offenders.keys()]).toEqual(["busy"]);
    expect(offenders.get("busy")?.reason).toContain("63.5%");
  });

  it("does not evict unrelated projects for lifecycle-only I/O pressure", () => {
    const now = Date.parse("2026-08-03T19:51:00.000Z");
    const metrics = {
      memory_used_percent: 20,
      memory_available_bytes: 32 * 1024 ** 3,
      storage_admission: {
        schema_version: 1 as const,
        collected_at: new Date(now).toISOString(),
        mode: "enforce" as const,
        pressure_state: "emergency" as const,
        state_since: new Date(now - 5 * 60_000).toISOString(),
        host_io_full_avg10: 25,
        project_pool_io_full_avg10: 0,
        effective_io_full_avg10: 25,
        uncontained_io_full_avg10: 25,
        lifecycle_active: 1,
        starting_projects: 1,
        stopping_projects: 0,
        active_by_priority: {
          lifecycle: 1,
          interactive: 0,
          scheduled: 0,
          scavenger: 0,
        },
        btrfs_mutation_locks: 0,
        btrfs_mutation_waiters: 0,
        admitted_total: 0,
        deferred_total: 0,
        observed_deferral_total: 0,
        transition_count: 1,
      },
    };

    expect(
      classifyHostPressure(metrics, now, {
        ioPressureMode: "enforce",
        ioPressureSinceMs: now - 5 * 60_000,
      }),
    ).toMatchObject({
      zone: "observe",
      reason: expect.stringContaining("storage_io_lifecycle_active"),
    });

    metrics.storage_admission.lifecycle_active = 0;
    metrics.storage_admission.starting_projects = 0;
    metrics.storage_admission.active_by_priority.lifecycle = 0;
    expect(
      classifyHostPressure(metrics, now, {
        ioPressureMode: "enforce",
        ioPressureSinceMs: now - 5 * 60_000,
      }),
    ).toMatchObject({ zone: "pressure" });
  });

  it("keeps I/O eviction candidates old and backed by activity policy", () => {
    const now = 10 * 60 * 60_000;
    const candidates = buildStopCandidates({
      zone: "pressure",
      now,
      minimumIdleMs: 6 * 60 * 60_000,
      requireActivityPolicy: true,
      projects: [
        { project_id: "proj-old", state: "running" },
        { project_id: "proj-recent", state: "running" },
        { project_id: "proj-unknown", state: "running" },
      ],
      policies: new Map([
        [
          "proj-old",
          {
            project_id: "proj-old",
            owner_account_id: "owner-1",
            shared_compute_priority: 0,
            authoritative_last_edited_ms: now - 8 * 60 * 60_000,
            policy_updated_ms: now,
            stop_override: "default",
          },
        ],
        [
          "proj-recent",
          {
            project_id: "proj-recent",
            owner_account_id: "owner-2",
            shared_compute_priority: 0,
            authoritative_last_edited_ms: now - 30 * 60_000,
            policy_updated_ms: now,
            stop_override: "default",
          },
        ],
      ]),
      getStopState: () => undefined,
    });

    expect(candidates.map(({ project_id }) => project_id)).toEqual([
      "proj-old",
    ]);
  });

  it("preserves project protections during an I/O emergency", () => {
    const now = 10 * 60 * 60_000;
    const policies = new Map([
      [
        "proj-startup",
        {
          project_id: "proj-startup",
          owner_account_id: "owner-1",
          shared_compute_priority: 0,
          authoritative_last_edited_ms: now - 8 * 60 * 60_000,
          policy_updated_ms: now,
          stop_override: "default" as const,
        },
      ],
      [
        "proj-protected",
        {
          project_id: "proj-protected",
          owner_account_id: "owner-2",
          shared_compute_priority: 0,
          authoritative_last_edited_ms: now - 8 * 60 * 60_000,
          policy_updated_ms: now,
          stop_override: "protect" as const,
        },
      ],
      [
        "proj-cooldown",
        {
          project_id: "proj-cooldown",
          owner_account_id: "owner-3",
          shared_compute_priority: 0,
          authoritative_last_edited_ms: now - 8 * 60 * 60_000,
          policy_updated_ms: now,
          stop_override: "default" as const,
        },
      ],
      [
        "proj-old",
        {
          project_id: "proj-old",
          owner_account_id: "owner-4",
          shared_compute_priority: 0,
          authoritative_last_edited_ms: now - 8 * 60 * 60_000,
          policy_updated_ms: now,
          stop_override: "default" as const,
        },
      ],
    ]);
    const candidates = buildStopCandidates({
      zone: "emergency",
      now,
      minimumIdleMs: 60 * 60_000,
      requireActivityPolicy: true,
      preserveEmergencyProtections: true,
      projects: [
        { project_id: "proj-starting", state: "starting" },
        { project_id: "proj-startup", state: "running" },
        { project_id: "proj-protected", state: "running" },
        { project_id: "proj-cooldown", state: "running" },
        { project_id: "proj-old", state: "running" },
      ],
      policies,
      getStopState: (project_id) => {
        if (project_id === "proj-startup") {
          return { project_id, last_started_ms: now - 60_000 };
        }
        if (project_id === "proj-cooldown") {
          return {
            project_id,
            pressure_cooldown_until_ms: now + 60_000,
          };
        }
        return undefined;
      },
    });

    expect(candidates.map(({ project_id }) => project_id)).toEqual([
      "proj-old",
    ]);
  });

  it("protects active member workloads but keeps priority zero evictable", () => {
    const now = 10 * 60 * 60_000;
    const policies = new Map([
      [
        "proj-active-member",
        {
          project_id: "proj-active-member",
          owner_account_id: "owner-1",
          shared_compute_priority: 1,
          authoritative_last_edited_ms: now - 8 * 60 * 60_000,
          policy_updated_ms: now,
          stop_override: "default" as const,
        },
      ],
      ...["proj-active-free", "proj-idle"].map(
        (project_id) =>
          [
            project_id,
            {
              project_id,
              owner_account_id: "owner-2",
              shared_compute_priority: 0,
              authoritative_last_edited_ms: now - 8 * 60 * 60_000,
              policy_updated_ms: now,
              stop_override: "default" as const,
            },
          ] as const,
      ),
    ]);
    const candidates = buildStopCandidates({
      zone: "pressure",
      now,
      minimumIdleMs: 6 * 60 * 60_000,
      requireActivityPolicy: true,
      workloadProtectedProjects: new Set([
        "proj-active-member",
        "proj-active-free",
      ]),
      projects: [
        { project_id: "proj-active-member", state: "running" },
        { project_id: "proj-active-free", state: "running" },
        { project_id: "proj-idle", state: "running" },
      ],
      policies,
      getStopState: () => undefined,
    });

    expect(candidates.map(({ project_id }) => project_id)).toEqual([
      "proj-active-free",
      "proj-idle",
    ]);
  });

  it("ranks older activity before tier", () => {
    const now = 2_000_000;
    const candidates = buildStopCandidates({
      zone: "pressure",
      now,
      projects: [
        {
          project_id: "proj-high",
          state: "running",
          run_quota: { memory_limit: 4000 },
        },
        {
          project_id: "proj-low",
          state: "running",
          run_quota: { memory_limit: 1000 },
        },
        {
          project_id: "proj-old",
          state: "running",
          run_quota: { memory_limit: 500 },
        },
      ],
      policies: new Map([
        [
          "proj-high",
          {
            project_id: "proj-high",
            owner_account_id: "owner-1",
            shared_compute_priority: 5,
            authoritative_last_edited_ms: 1900,
            policy_updated_ms: 1900,
            stop_override: "default",
          },
        ],
        [
          "proj-low",
          {
            project_id: "proj-low",
            owner_account_id: "owner-2",
            shared_compute_priority: 0,
            authoritative_last_edited_ms: 1950,
            policy_updated_ms: 1950,
            stop_override: "default",
          },
        ],
        [
          "proj-old",
          {
            project_id: "proj-old",
            owner_account_id: "owner-3",
            shared_compute_priority: 0,
            authoritative_last_edited_ms: 1200,
            policy_updated_ms: 1200,
            stop_override: "default",
          },
        ],
      ]),
      getStopState: () => undefined,
    });

    expect(candidates.map((candidate) => candidate.project_id)).toEqual([
      "proj-old",
      "proj-high",
      "proj-low",
    ]);
  });

  it.each(
    [0, 1, 5, 100].flatMap((olderTier) =>
      [0, 1, 5, 100].map((newerTier) => [olderTier, newerTier]),
    ),
  )(
    "always ranks the more idle ordinary candidate first: tiers %i vs %i",
    (olderTier, newerTier) => {
      const now = 10 * 60 * 60_000;
      const minimumIdleMs = 60 * 60_000;
      const policies = new Map(
        ["older", "newer"].map((project_id) => [
          project_id,
          {
            project_id,
            owner_account_id: "owner",
            shared_compute_priority:
              project_id === "older" ? olderTier : newerTier,
            authoritative_last_edited_ms:
              now - minimumIdleMs - (project_id === "older" ? 1 : 0),
            policy_updated_ms: now,
            stop_override:
              project_id === "older"
                ? ("default" as const)
                : ("deprioritize" as const),
          },
        ]),
      );
      for (const order of [
        ["newer", "older"],
        ["older", "newer"],
      ]) {
        const candidates = buildStopCandidates({
          zone: "pressure",
          now,
          minimumIdleMs,
          projects: order.map((project_id) => ({
            project_id,
            state: "running",
          })),
          policies,
          getStopState: () => undefined,
        });
        expect(candidates.map(({ project_id }) => project_id)).toEqual([
          "older",
          "newer",
        ]);
      }
    },
  );

  it.each(["pressure", "emergency"] as const)(
    "uses tier and deprioritize only after idleness in %s",
    (zone) => {
      const now = 10 * 60 * 60_000;
      const rows = [
        ["recent-free", 0, now - 60_000, "deprioritize"],
        ["older-paid", 5, now - 2 * 60 * 60_000, "default"],
        ["oldest-paid", 5, now - 8 * 60 * 60_000, "default"],
        ["oldest-free", 0, now - 8 * 60 * 60_000, "default"],
        ["oldest-deprioritized", 5, now - 8 * 60 * 60_000, "deprioritize"],
      ] as const;
      const candidates = buildStopCandidates({
        zone,
        now,
        projects: rows.map(([project_id]) => ({
          project_id,
          state: "running",
        })),
        policies: new Map(
          rows.map(
            ([
              project_id,
              shared_compute_priority,
              authoritative_last_edited_ms,
              stop_override,
            ]) => [
              project_id,
              {
                project_id,
                owner_account_id: "owner",
                shared_compute_priority,
                authoritative_last_edited_ms,
                stop_override,
                policy_updated_ms: now,
              },
            ],
          ),
        ),
        getStopState: () => undefined,
      });
      expect(candidates.map(({ project_id }) => project_id)).toEqual([
        "oldest-deprioritized",
        "oldest-free",
        "oldest-paid",
        "older-paid",
        "recent-free",
      ]);
    },
  );

  it("does not treat open-page heartbeats as edits or permanent protection", () => {
    const now = 10 * 60 * 60_000;
    const candidates = buildStopCandidates({
      zone: "pressure",
      now,
      minimumIdleMs: 10 * 60_000,
      projects: [
        { project_id: "old-open-tab", state: "running" },
        { project_id: "newer-edit", state: "running" },
      ],
      policies: new Map(
        ["old-open-tab", "newer-edit"].map((project_id, index) => [
          project_id,
          {
            project_id,
            owner_account_id: "owner",
            shared_compute_priority: 0,
            authoritative_last_edited_ms: now - (8 - index) * 60 * 60_000,
            policy_updated_ms: now,
            stop_override: "default",
          },
        ]),
      ),
      getStopState: (project_id) =>
        project_id === "old-open-tab"
          ? { project_id, last_browser_activity_ms: now - 1_000 }
          : undefined,
    });
    expect(candidates.map(({ project_id }) => project_id)).toEqual([
      "old-open-tab",
      "newer-edit",
    ]);
    expect(candidates[0].explanation).toEqual(
      expect.arrayContaining([
        `idle_ms:${8 * 60 * 60_000}`,
        "browser_presence_age_ms:1000",
      ]),
    );
    expect(candidates[1].explanation).toContain(
      "browser_presence_age_ms:unknown",
    );
  });

  it("excludes startup-protected and protected projects in pressure", () => {
    const now = 2_000_000;
    const candidates = buildStopCandidates({
      zone: "pressure",
      now,
      projects: [
        { project_id: "proj-starting", state: "running" },
        { project_id: "proj-protected", state: "running" },
        { project_id: "proj-default", state: "running" },
      ],
      policies: new Map([
        [
          "proj-starting",
          {
            project_id: "proj-starting",
            owner_account_id: "owner-1",
            shared_compute_priority: 0,
            authoritative_last_edited_ms: 1000,
            policy_updated_ms: 1000,
            stop_override: "default",
          },
        ],
        [
          "proj-protected",
          {
            project_id: "proj-protected",
            owner_account_id: "owner-2",
            shared_compute_priority: 0,
            authoritative_last_edited_ms: 1000,
            policy_updated_ms: 1000,
            stop_override: "protect",
          },
        ],
      ]),
      getStopState: (project_id) =>
        project_id === "proj-starting"
          ? {
              project_id,
              last_started_ms: now - 60_000,
            }
          : undefined,
    });

    expect(candidates.map((candidate) => candidate.project_id)).toEqual([
      "proj-default",
    ]);
  });

  it("allows emergency ranking to bypass startup protection and protect override", () => {
    const now = 2_000_000;
    const candidates = buildStopCandidates({
      zone: "emergency",
      now,
      projects: [
        { project_id: "proj-default", state: "running" },
        { project_id: "proj-starting", state: "starting" },
        { project_id: "proj-protected", state: "running" },
      ],
      policies: new Map([
        [
          "proj-protected",
          {
            project_id: "proj-protected",
            owner_account_id: "owner-2",
            shared_compute_priority: 0,
            authoritative_last_edited_ms: 1000,
            policy_updated_ms: 1000,
            stop_override: "protect",
          },
        ],
      ]),
      getStopState: (project_id) =>
        project_id === "proj-starting"
          ? {
              project_id,
              last_started_ms: now - 60_000,
            }
          : undefined,
    });

    expect(candidates.map((candidate) => candidate.project_id)).toEqual([
      "proj-protected",
      "proj-default",
      "proj-starting",
    ]);
  });

  it("ranks direct resource offenders ahead of generic pressure candidates", () => {
    const now = 2_000_000;
    const candidates = buildStopCandidates({
      zone: "pressure",
      now,
      minimumIdleMs: 10 * 60_000,
      directResourceOffenders: new Map([
        [
          "proj-protected",
          {
            project_id: "proj-protected",
            reason:
              "resource_project_inotify_watches>=262144,actual=300000,project=proj-protected",
            score: 2,
            zone: "pressure",
          },
        ],
      ]),
      projects: [
        { project_id: "proj-default", state: "running" },
        { project_id: "proj-protected", state: "running" },
      ],
      policies: new Map([
        [
          "proj-default",
          {
            project_id: "proj-default",
            owner_account_id: "owner-1",
            shared_compute_priority: 0,
            authoritative_last_edited_ms: 1000,
            policy_updated_ms: 1000,
            stop_override: "default",
          },
        ],
        [
          "proj-protected",
          {
            project_id: "proj-protected",
            owner_account_id: "owner-2",
            shared_compute_priority: 100,
            authoritative_last_edited_ms: now - 60_000,
            policy_updated_ms: 1000,
            stop_override: "protect",
          },
        ],
      ]),
      getStopState: (project_id) =>
        project_id === "proj-protected"
          ? {
              project_id,
              last_started_ms: now - 60_000,
              pressure_cooldown_until_ms: now + 60_000,
            }
          : undefined,
    });

    expect(candidates.map((candidate) => candidate.project_id)).toEqual([
      "proj-protected",
      "proj-default",
    ]);
    expect(candidates[0].explanation.join(",")).toContain("direct:resource");
  });

  it("keeps an unknown-policy direct offender stoppable without inventing a tier", () => {
    const now = 10 * 60 * 60_000;
    const candidates = buildStopCandidates({
      zone: "pressure",
      now,
      minimumIdleMs: 60 * 60_000,
      projects: [{ project_id: "offender", state: "running" }],
      policies: new Map(),
      directResourceOffenders: new Map([
        [
          "offender",
          {
            project_id: "offender",
            score: 2,
            zone: "pressure",
            reason: "resource_project_inotify_watches",
          },
        ],
      ]),
      getStopState: (project_id) => ({
        project_id,
        last_started_ms: now - 60_000,
        pressure_cooldown_until_ms: now + 60_000,
      }),
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].shared_compute_priority).toBeUndefined();
    expect(candidates[0].explanation).toEqual(
      expect.arrayContaining([
        "policy_missing",
        "priority:unknown",
        "idle_ms:unknown",
        "direct:resource_project_inotify_watches",
      ]),
    );
  });

  it("escalates repeated pressure stops to quarantine", () => {
    const generic = pressureStopStateUpdate({
      existing: undefined,
      project_id: "proj-1",
      now: 900_000,
      reason: "priority:0,state:running",
      zone: "pressure",
    });
    expect(generic.pressure_stop_count).toBeUndefined();
    expect(generic.pressure_quarantine_until_ms).toBeUndefined();

    const first = pressureStopStateUpdate({
      existing: undefined,
      project_id: "proj-1",
      now: 1_000_000,
      reason: "direct:resource_project_inotify_watches",
      zone: "pressure",
    });
    expect(first.pressure_stop_count).toBe(1);
    expect(first.pressure_quarantine_until_ms).toBeNull();

    const second = pressureStopStateUpdate({
      existing: first,
      project_id: "proj-1",
      now: 1_100_000,
      reason: "direct:resource_project_inotify_watches",
      zone: "pressure",
    });
    expect(second.pressure_stop_count).toBe(2);
    expect(second.pressure_cooldown_until_ms).toBeGreaterThan(
      first.pressure_cooldown_until_ms ?? 0,
    );
    expect(second.pressure_quarantine_until_ms).toBeNull();

    const third = pressureStopStateUpdate({
      existing: second,
      project_id: "proj-1",
      now: 1_200_000,
      reason: "direct:resource_project_inotify_instances",
      zone: "pressure",
    });
    expect(third.pressure_stop_count).toBe(3);
    expect(third.pressure_quarantine_until_ms).toBeGreaterThan(1_200_000);
    expect(third.pressure_quarantine_reason).toContain(
      "resource_project_inotify_instances",
    );
  });
});
