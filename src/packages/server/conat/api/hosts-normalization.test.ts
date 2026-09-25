/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  computeHostOperationalAvailability,
  parseRow,
} from "./hosts-normalization";

describe("parseRow host metrics normalization", () => {
  it("preserves a bounded RootFS placement cache snapshot", () => {
    const observed_at = new Date().toISOString();
    const host = parseRow({
      id: "host-placement",
      name: "Placement host",
      status: "running",
      metadata: {
        placement: {
          observed_at,
          cached_rootfs_images: [
            " cocalc.local/rootfs/python ",
            "cocalc.local/rootfs/python",
            5,
          ],
          rootfs_cache_truncated: true,
        },
      },
    });

    expect(host.placement).toEqual({
      observed_at,
      cached_rootfs_images: ["cocalc.local/rootfs/python"],
      rootfs_cache_truncated: true,
    });
  });

  it("preserves sampled shared scratch metrics", () => {
    const host = parseRow({
      id: "host-1",
      name: "host-1",
      status: "running",
      region: "us-west3",
      metadata: {
        metrics: {
          current: {
            collected_at: "2026-06-08T12:00:00.000Z",
            disk_device_total_bytes: "1000",
            shared_scratch_total_bytes: "500",
            shared_scratch_used_bytes: "125",
            shared_scratch_available_bytes: "375",
          },
        },
      },
    });

    expect(host.metrics?.current).toMatchObject({
      disk_device_total_bytes: 1000,
      shared_scratch_total_bytes: 500,
      shared_scratch_used_bytes: 125,
      shared_scratch_available_bytes: 375,
    });
  });

  it("preserves valid I/O containment and storage admission telemetry", () => {
    const ioContainment = {
      collected_at: "2026-07-29T12:00:00.000Z",
      policy_mode: "enforce",
      mountpoint: "/mnt/cocalc",
      capability: "validated",
      pool_cgroup: "/sys/fs/cgroup/cocalc-project-pool",
      devices: [],
      top_projects: [],
      sampled_project_count: 3,
      total_project_count: 3,
      stale_project_count: 0,
      truncated: false,
      maintenance_cgroup: "/sys/fs/cgroup/cocalc-maintenance",
      maintenance_process_count: 1,
    };
    const storageAdmission = {
      schema_version: 1,
      collected_at: "2026-07-29T12:00:00.000Z",
      mode: "observe",
      pressure_state: "contended",
      state_since: "2026-07-29T11:59:00.000Z",
      lifecycle_active: 1,
      starting_projects: 1,
      stopping_projects: 0,
      active_by_priority: {
        lifecycle: 1,
        interactive: 0,
        scheduled: 0,
        scavenger: 0,
      },
      btrfs_mutation_locks: 1,
      btrfs_mutation_waiters: 2,
      admitted_total: 4,
      deferred_total: 0,
      observed_deferral_total: 2,
      transition_count: 1,
    };
    const host = parseRow({
      id: "host-1",
      name: "host-1",
      status: "running",
      region: "us-west3",
      metadata: {
        metrics: {
          current: {
            io_containment: ioContainment,
            storage_admission: storageAdmission,
          },
        },
      },
    });

    expect(host.metrics?.current?.io_containment).toEqual(ioContainment);
    expect(host.metrics?.current?.storage_admission).toEqual(storageAdmission);
  });

  it("preserves a validated snapshot and backup memory gate", () => {
    const checked_at = new Date().toISOString();
    const host = parseRow({
      id: "host-1",
      name: "host-1",
      status: "running",
      metadata: {
        metrics: {
          current: {
            snapshot_backup_maintenance_gate: {
              checked_at,
              blocked_reason: "memory_pressure",
              memory_psi_full_avg10: 52.48,
            },
          },
        },
      },
    });
    expect(host.metrics?.current?.snapshot_backup_maintenance_gate).toEqual({
      checked_at,
      blocked_reason: "memory_pressure",
      memory_psi_full_avg10: 52.48,
    });
  });

  it("preserves a verified isolated Bees pressure attribution", () => {
    const checked_at = new Date().toISOString();
    const host = parseRow({
      id: "host-1",
      name: "host-1",
      status: "running",
      metadata: {
        metrics: {
          current: {
            snapshot_backup_maintenance_gate: {
              checked_at,
              memory_psi_full_avg10: 49.8,
              pressure_attribution: "bees_cgroup",
            },
          },
        },
      },
    });
    expect(host.metrics?.current?.snapshot_backup_maintenance_gate).toEqual({
      checked_at,
      memory_psi_full_avg10: 49.8,
      pressure_attribution: "bees_cgroup",
    });
  });

  it("rejects malformed I/O control telemetry", () => {
    const host = parseRow({
      id: "host-1",
      name: "host-1",
      status: "running",
      region: "us-west3",
      metadata: {
        metrics: {
          current: {
            io_containment: {
              collected_at: "2026-07-29T12:00:00.000Z",
              policy_mode: "unlimited",
            },
            storage_admission: {
              schema_version: 1,
              mode: "enforce",
              pressure_state: "unknown",
            },
          },
        },
      },
    });

    expect(host.metrics?.current?.io_containment).toBeUndefined();
    expect(host.metrics?.current?.storage_admission).toBeUndefined();
  });
});

describe("parseRow BEES telemetry normalization", () => {
  it("preserves valid status and rejects malformed status", () => {
    const valid = parseRow({
      id: "host-1",
      name: "host-1",
      status: "running",
      region: "us-west3",
      metadata: {
        bees: {
          enabled: true,
          running: true,
          telemetry: {
            assessment: "active",
            average_cpu_cores: 1.25,
            stall_observation_ms: 5_400_000,
            sample: {
              cgroup: {
                path: "/sys/fs/cgroup/cocalc-bees",
                cpu_max: "400000 100000",
              },
            },
          },
        },
      },
    });
    const malformed = parseRow({
      id: "host-2",
      name: "host-2",
      status: "running",
      region: "us-west3",
      metadata: { bees: { enabled: "yes", running: true } },
    });

    expect(valid.bees).toMatchObject({
      enabled: true,
      running: true,
      telemetry: {
        assessment: "active",
        average_cpu_cores: 1.25,
        sample: {
          cgroup: {
            path: "/sys/fs/cgroup/cocalc-bees",
            cpu_max: "400000 100000",
          },
        },
      },
    });
    expect(malformed.bees).toBeUndefined();
  });
});

describe("parseRow bootstrap lifecycle normalization", () => {
  it("rewrites stale bootstrap desired bundle versions from current runtime targets", () => {
    const host = parseRow(
      {
        id: "host-1",
        name: "host-1",
        status: "running",
        version: "1776559164732",
        region: "us-west3",
        metadata: {
          software: {
            project_host: "1776559164732",
            project_bundle: "1776560093917",
            tools: "1775834120905",
          },
          bootstrap: {
            status: "done",
            updated_at: "2026-04-19T02:08:00.000Z",
            message: "Host software reconciled",
          },
          bootstrap_lifecycle: {
            desired_recorded_at: "2026-04-19T02:07:17.000Z",
            installed_recorded_at: "2026-04-19T02:07:25.000Z",
            summary_status: "in_sync",
            summary_message: "desired and installed software are aligned",
            drift_count: 0,
            items: [
              {
                key: "project_host_bundle",
                label: "Project host bundle",
                status: "match",
                desired: "1776557040637",
                installed: "1776559164732",
                message: "installed bundle is newer than desired",
              },
              {
                key: "project_bundle",
                label: "Project bundle",
                status: "match",
                desired: "1776556035748",
                installed: "1776560093917",
                message: "installed bundle is newer than desired",
              },
              {
                key: "tools_bundle",
                label: "Tools bundle",
                status: "match",
                desired: "1775834120905",
                installed: "1775834120905",
              },
            ],
          },
        },
      },
      {
        runtime_desired_artifacts: {
          project_host: "1776559164732",
          project_bundle: "1776560093917",
          tools: "1775834120905",
          updated_at: "2026-04-19T02:07:52.704Z",
        },
      },
    );

    expect(host.bootstrap_lifecycle?.desired_recorded_at).toBe(
      "2026-04-19T02:07:52.704Z",
    );
    expect(host.bootstrap_lifecycle?.summary_status).toBe("in_sync");
    expect(host.bootstrap_lifecycle?.drift_count).toBe(0);
    expect(
      host.bootstrap_lifecycle?.items.find(
        (item) => item.key === "project_host_bundle",
      ),
    ).toMatchObject({
      status: "match",
      desired: "1776559164732",
      installed: "1776559164732",
    });
    expect(
      host.bootstrap_lifecycle?.items.find(
        (item) => item.key === "project_bundle",
      ),
    ).toMatchObject({
      status: "match",
      desired: "1776560093917",
      installed: "1776560093917",
    });
    expect(
      host.bootstrap_lifecycle?.items.find(
        (item) => item.key === "project_host_bundle",
      )?.message,
    ).toBeUndefined();
    expect(host.bootstrap?.status).toBe("done");
  });

  it("clears a stale bootstrap error once rewritten runtime targets are fully aligned", () => {
    const host = parseRow(
      {
        id: "host-1",
        name: "host-1",
        status: "running",
        version: "1776577465070",
        region: "us-west3",
        metadata: {
          software: {
            project_host: "1776577465070",
            project_bundle: "1776575204948",
            tools: "1775834120905",
          },
          bootstrap: {
            status: "error",
            updated_at: "2026-04-19T05:45:43.935Z",
            message: "bootstrap failed (exit 1) at line 201",
          },
          bootstrap_lifecycle: {
            desired_recorded_at: "2026-04-19T05:45:42.000Z",
            installed_recorded_at: "2026-04-19T05:45:43.000Z",
            last_reconcile_result: "error",
            last_reconcile_started_at: "2026-04-19T05:45:43.000Z",
            last_reconcile_finished_at: "2026-04-19T05:45:43.000Z",
            last_error:
              "download https://lite4b.cocalc.ai/software/project-host/1776559164732/bundle-linux.tar.xz via curl failed with exit code 22",
            summary_status: "error",
            summary_message:
              "download https://lite4b.cocalc.ai/software/project-host/1776559164732/bundle-linux.tar.xz via curl failed with exit code 22",
            drift_count: 0,
            items: [
              {
                key: "project_host_bundle",
                label: "Project host bundle",
                status: "match",
                desired: "1776559164732",
                installed: "1776577465070",
                message: "installed bundle is newer than desired",
              },
              {
                key: "project_bundle",
                label: "Project bundle",
                status: "match",
                desired: "1776575204948",
                installed: "1776575204948",
              },
              {
                key: "tools_bundle",
                label: "Tools bundle",
                status: "match",
                desired: "1775834120905",
                installed: "1775834120905",
              },
            ],
          },
        },
      },
      {
        runtime_desired_artifacts: {
          project_host: "1776577465070",
          project_bundle: "1776575204948",
          tools: "1775834120905",
          updated_at: "2026-04-19T05:47:12.288Z",
        },
      },
    );

    expect(host.bootstrap_lifecycle?.summary_status).toBe("in_sync");
    expect(host.bootstrap_lifecycle?.summary_message).toBe(
      "desired and installed software are aligned",
    );
    expect(host.bootstrap_lifecycle?.drift_count).toBe(0);
    expect(host.bootstrap?.status).toBe("done");
    expect(host.bootstrap?.message).toBe(
      "desired and installed software are aligned",
    );
    expect(
      host.bootstrap_lifecycle?.items.find(
        (item) => item.key === "project_host_bundle",
      ),
    ).toMatchObject({
      status: "match",
      desired: "1776577465070",
      installed: "1776577465070",
    });
  });

  it("treats stale build-id and older numeric desired artifacts as aligned with installed runtime versions", () => {
    const host = parseRow(
      {
        id: "host-1",
        name: "host-1",
        status: "running",
        version: "1777603320059",
        region: "us-west3",
        metadata: {
          software: {
            project_host: "1777603320059",
            project_bundle: "1777650485714",
            tools: "1777042500614",
          },
          bootstrap: {
            status: "done",
            updated_at: "2026-05-01T16:32:31.560Z",
            message: "Host software reconciled",
          },
          bootstrap_lifecycle: {
            desired_recorded_at: "2026-05-01T16:32:19.000Z",
            installed_recorded_at: "2026-05-01T16:32:31.000Z",
            summary_status: "drifted",
            summary_message: "2 drift items detected",
            drift_count: 2,
            items: [
              {
                key: "project_host_bundle",
                label: "Project host bundle",
                status: "drift",
                desired: "20260501T024149Z-d8da8fa36b1e-dirty-789d9dbc",
                installed: "1777603320059",
              },
              {
                key: "project_bundle",
                label: "Project bundle",
                status: "drift",
                desired: "1777603336287",
                installed: "1777650485714",
              },
              {
                key: "tools_bundle",
                label: "Tools bundle",
                status: "match",
                desired: "1777042500614",
                installed: "1777042500614",
              },
            ],
          },
        },
      },
      {
        runtime_desired_artifacts: {
          project_host: "20260501T024149Z-d8da8fa36b1e-dirty-789d9dbc",
          project_bundle: "1777603336287",
          tools: "1777042500614",
          updated_at: "2026-05-01T16:32:19.000Z",
        },
      },
    );

    expect(host.bootstrap_lifecycle?.summary_status).toBe("in_sync");
    expect(host.bootstrap_lifecycle?.drift_count).toBe(0);
    expect(
      host.bootstrap_lifecycle?.items.find(
        (item) => item.key === "project_host_bundle",
      ),
    ).toMatchObject({
      status: "match",
      desired: "1777603320059",
      installed: "1777603320059",
    });
    expect(
      host.bootstrap_lifecycle?.items.find(
        (item) => item.key === "project_bundle",
      ),
    ).toMatchObject({
      status: "match",
      desired: "1777650485714",
      installed: "1777650485714",
    });
  });

  it("exposes desired and effective pricing separately during standard fallback", () => {
    const host = parseRow({
      id: "host-spot",
      name: "host-spot",
      status: "running",
      region: "us-west1",
      metadata: {
        owner: "acct-1",
        pricing_model: "spot",
        desired_pricing_model: "spot",
        effective_pricing_model: "on_demand",
        interruption_restore_policy: "immediate",
        spot_recovery_policy: {
          standard_fallback_enabled: true,
          standard_fallback_min_minutes: 20,
        },
        spot_recovery_state: {
          phase: "running_standard_fallback",
          outage_started_at: "2026-05-03T20:00:00.000Z",
          fallback_started_at: "2026-05-03T20:10:00.000Z",
        },
      },
    });

    expect(host.pricing_model).toBe("spot");
    expect(host.desired_pricing_model).toBe("spot");
    expect(host.effective_pricing_model).toBe("on_demand");
    expect(host.recovery_phase).toBe("running_standard_fallback");
    expect(host.spot_recovery_policy).toMatchObject({
      standard_fallback_enabled: true,
      standard_fallback_min_minutes: 20,
    });
    expect(host.spot_recovery_state).toMatchObject({
      phase: "running_standard_fallback",
      fallback_started_at: "2026-05-03T20:10:00.000Z",
    });
  });

  it("copies shared scratch provider identity into machine metadata", () => {
    const host = parseRow({
      id: "host-scratch",
      name: "host-scratch",
      status: "running",
      region: "us-south1",
      metadata: {
        machine: {
          cloud: "gcp",
          shared_disk_gb: 75,
          shared_disk_type: "balanced",
          metadata: {
            shared_disk_mount: "/mnt/cocalc-scratch",
            shared_disk_filesystem: "ext4",
          },
        },
        runtime: {
          metadata: {
            shared_disk_id: "host-scratch-disk",
            shared_disk_name: "host-scratch-disk",
          },
        },
      },
    });

    expect(host.machine?.metadata?.shared_disk_id).toBe("host-scratch-disk");
    expect(host.machine?.metadata?.shared_disk_name).toBe("host-scratch-disk");
  });
});

describe("computeHostOperationalAvailability", () => {
  const plannedTransitionMetadata = (overrides: Record<string, any> = {}) => ({
    runtime_deployments: {
      planned_project_host_transition: {
        operation_id: "upgrade-op-1",
        component: "project-host",
        started_at: new Date(Date.now() - 30_000).toISOString(),
        deadline_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        banner_suppression_until: new Date(
          Date.now() + 3 * 60_000,
        ).toISOString(),
      },
    },
    ...overrides,
  });

  it("dates a stale-heartbeat outage from the end of the heartbeat window", () => {
    const lastSeen = new Date(Date.now() - 3 * 60_000);
    expect(
      computeHostOperationalAvailability({
        status: "running",
        last_seen: lastSeen,
        metadata: {},
      }),
    ).toMatchObject({
      operational: false,
      online: false,
      unavailable_since: new Date(
        lastSeen.getTime() + 2 * 60_000,
      ).toISOString(),
    });
  });

  it("removes a host from placement during a planned project-host upgrade", () => {
    expect(
      computeHostOperationalAvailability({
        status: "running",
        last_seen: new Date(),
        metadata: plannedTransitionMetadata({
          runtime_health: { status: "ready", ready: true },
        }),
      }),
    ).toMatchObject({
      operational: false,
      online: true,
      reason_unavailable: "Host is undergoing a planned project-host upgrade.",
    });
  });

  it("suppresses transient runtime and route failures for assigned projects during the planned grace window", () => {
    expect(
      computeHostOperationalAvailability(
        {
          status: "running",
          last_seen: new Date(),
          metadata: plannedTransitionMetadata({
            runtime_health: { status: "starting", ready: false },
            public_route_probe: {
              status: "failed",
              quarantined: true,
              error: "Cloudflare returned 520",
            },
          }),
        },
        { allowPlannedProjectHostTransition: true },
      ),
    ).toMatchObject({ operational: true, online: true });
  });

  it("does not suppress a real failure after the planned grace window", () => {
    expect(
      computeHostOperationalAvailability(
        {
          status: "running",
          last_seen: new Date(),
          metadata: plannedTransitionMetadata({
            runtime_deployments: {
              planned_project_host_transition: {
                operation_id: "upgrade-op-1",
                component: "project-host",
                started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
                deadline_at: new Date(Date.now() + 5 * 60_000).toISOString(),
                banner_suppression_until: new Date(
                  Date.now() - 60_000,
                ).toISOString(),
              },
            },
            runtime_health: { status: "starting", ready: false },
          }),
        },
        { allowPlannedProjectHostTransition: true },
      ),
    ).toMatchObject({
      operational: false,
      online: true,
      reason_unavailable: "Host project runtime is still starting.",
    });
  });

  it("quarantines hosts without runtime-health metadata", () => {
    expect(
      computeHostOperationalAvailability({
        status: "running",
        last_seen: new Date(),
        metadata: {},
      }),
    ).toMatchObject({
      operational: false,
      online: true,
      reason_unavailable: "Host has not reported project runtime health.",
    });
  });

  it("excludes a heartbeat-fresh host with degraded Podman", () => {
    expect(
      computeHostOperationalAvailability({
        status: "running",
        last_seen: new Date(),
        metadata: {
          runtime_health: {
            status: "degraded",
            ready: false,
            error: "podman ps timed out",
          },
        },
      }),
    ).toMatchObject({
      operational: false,
      online: true,
      reason_unavailable:
        "Host project runtime is degraded: podman ps timed out",
    });
  });

  it("excludes a host whose synthetic project probe failed", () => {
    expect(
      computeHostOperationalAvailability({
        status: "running",
        last_seen: new Date(),
        metadata: {
          runtime_health: { status: "ready", ready: true },
          runtime_synthetic_probe: {
            status: "failed",
            quarantined: true,
            error: "project exec timed out",
          },
        },
      }),
    ).toMatchObject({
      operational: false,
      online: true,
      reason_unavailable:
        "Host synthetic project probe failed: project exec timed out",
    });
  });

  it("allows existing-project connections through synthetic quarantine", () => {
    expect(
      computeHostOperationalAvailability(
        {
          status: "running",
          last_seen: new Date(),
          metadata: {
            runtime_health: { status: "ready", ready: true },
            runtime_synthetic_probe: {
              status: "failed",
              quarantined: true,
              error: "project exec timed out",
            },
          },
        },
        { includeSyntheticProbe: false },
      ),
    ).toMatchObject({ operational: true, online: true });
  });

  it("allows legacy synthetic-only runtime degradation for existing projects", () => {
    expect(
      computeHostOperationalAvailability(
        {
          status: "running",
          last_seen: new Date(),
          metadata: {
            runtime_health: {
              status: "degraded",
              ready: false,
              consecutive_failures: 0,
              podman_latency_ms: 77,
              error: "synthetic project probe failed",
              synthetic_probe: {
                status: "failed",
                error: "synthetic project probe failed",
              },
            },
            runtime_synthetic_probe: {
              status: "failed",
              quarantined: true,
            },
          },
        },
        { includeSyntheticProbe: false },
      ),
    ).toMatchObject({ operational: true, online: true });
  });

  it("keeps a host operational after one transient Podman failure", () => {
    expect(
      computeHostOperationalAvailability({
        status: "running",
        last_seen: new Date(),
        metadata: {
          runtime_health: {
            status: "degraded",
            ready: false,
            consecutive_failures: 1,
            error: "podman ps timed out",
          },
        },
      }),
    ).toMatchObject({ operational: true, online: true });
  });

  it("degrades a host after two consecutive Podman failures", () => {
    expect(
      computeHostOperationalAvailability({
        status: "running",
        last_seen: new Date(),
        metadata: {
          runtime_health: {
            status: "degraded",
            ready: false,
            consecutive_failures: 2,
            error: "podman ps timed out",
          },
        },
      }),
    ).toMatchObject({
      operational: false,
      online: true,
      reason_unavailable:
        "Host project runtime is degraded: podman ps timed out",
    });
  });

  it("does not quarantine a host after only one synthetic failure", () => {
    expect(
      computeHostOperationalAvailability({
        status: "running",
        last_seen: new Date(),
        metadata: {
          runtime_health: { status: "ready", ready: true },
          runtime_synthetic_probe: {
            status: "failed",
            consecutive_failures: 1,
            quarantined: false,
            error: "transient project exec failure",
          },
        },
      }),
    ).toMatchObject({ operational: true, online: true });
  });

  it("does not quarantine a host after only one public-route failure", () => {
    expect(
      computeHostOperationalAvailability({
        status: "running",
        last_seen: new Date(),
        metadata: {
          runtime_health: { status: "ready", ready: true },
          public_route_probe: {
            status: "failed",
            consecutive_failures: 1,
            quarantined: false,
            error: "Cloudflare returned 502",
          },
        },
      }),
    ).toMatchObject({ operational: true, online: true });
  });

  it("excludes a host with a quarantined public browser route", () => {
    expect(
      computeHostOperationalAvailability({
        status: "running",
        last_seen: new Date(),
        metadata: {
          runtime_health: { status: "ready", ready: true },
          public_route_probe: {
            status: "failed",
            consecutive_failures: 2,
            quarantined: true,
            error: "Cloudflare returned 502",
          },
        },
      }),
    ).toMatchObject({
      operational: false,
      online: true,
      reason_unavailable:
        "Host public browser route is degraded: Cloudflare returned 502",
    });
  });

  it("exposes sanitized public-route probe state", () => {
    const host = parseRow({
      id: "host-public-route",
      name: "host-public-route",
      status: "running",
      last_seen: new Date(),
      metadata: {
        runtime_health: { status: "ready", ready: true },
        public_route_probe: {
          status: "failed",
          claim_id: "private-claim",
          checked_at: "2026-07-15T20:00:00.000Z",
          duration_ms: 321,
          consecutive_failures: 2,
          consecutive_successes: 0,
          quarantined: true,
          error: "missing CORS",
          alerted_at: "2026-07-15T20:00:01.000Z",
          result: {
            public_url: "https://host.example.test",
            origin: "https://cocalc.example.test",
            health_status: 200,
            preflight_status: 204,
            session_status: 401,
            edge_server: "cloudflare",
            cf_ray: "ray-1",
          },
        },
      },
    });
    expect(host.public_route_probe).toEqual({
      status: "failed",
      checked_at: "2026-07-15T20:00:00.000Z",
      duration_ms: 321,
      consecutive_failures: 2,
      consecutive_successes: 0,
      quarantined: true,
      error: "missing CORS",
      health_status: 200,
      preflight_status: 204,
      session_status: 401,
      edge_server: "cloudflare",
      cf_ray: "ray-1",
    });
    expect(host.public_route_probe).not.toHaveProperty("claim_id");
    expect(host.public_route_probe).not.toHaveProperty("alerted_at");
  });
});
