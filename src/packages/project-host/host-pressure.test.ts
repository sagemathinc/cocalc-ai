/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { _test } from "./host-pressure";

const {
  buildStopCandidates,
  classifyHostPressure,
  pressureStopStateUpdate,
  resourcePressureFindings,
} = _test;

describe("host pressure controller helpers", () => {
  it("classifies memory pressure zones", () => {
    expect(
      classifyHostPressure({
        memory_used_percent: 50,
        memory_available_bytes: 8 * 1024 ** 3,
      }),
    ).toMatchObject({ zone: "normal" });
    expect(
      classifyHostPressure({
        memory_used_percent: 86,
        memory_available_bytes: 8 * 1024 ** 3,
      }),
    ).toMatchObject({ zone: "observe" });
    expect(
      classifyHostPressure({
        memory_used_percent: 91,
        memory_available_bytes: 8 * 1024 ** 3,
      }),
    ).toMatchObject({ zone: "pressure" });
    expect(
      classifyHostPressure({
        memory_used_percent: 91,
        memory_available_bytes: 400 * 1024 ** 2,
      }),
    ).toMatchObject({ zone: "emergency" });
  });

  it("classifies resource pressure only when resource mode is enabled", () => {
    const metrics = {
      memory_used_percent: 20,
      memory_available_bytes: 8 * 1024 ** 3,
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

  it("ranks lower priority and older activity first", () => {
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
      "proj-low",
      "proj-high",
    ]);
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
      "proj-default",
      "proj-starting",
      "proj-protected",
    ]);
  });

  it("ranks direct resource offenders ahead of generic pressure candidates", () => {
    const now = 2_000_000;
    const candidates = buildStopCandidates({
      zone: "pressure",
      now,
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
          "proj-protected",
          {
            project_id: "proj-protected",
            owner_account_id: "owner-2",
            shared_compute_priority: 100,
            authoritative_last_edited_ms: 1000,
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
