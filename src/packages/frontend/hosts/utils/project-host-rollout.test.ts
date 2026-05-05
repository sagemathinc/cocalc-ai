import {
  currentProjectHostAutomaticRollback,
  currentProjectHostRolloutPhase,
  projectHostRollbackReasonLabel,
  shouldSuppressProjectHostFailedOp,
} from "./project-host-rollout";

describe("project-host-rollout", () => {
  test("currentProjectHostAutomaticRollback only returns a rollback when the host is still on the rollback version", () => {
    expect(
      currentProjectHostAutomaticRollback({
        currentVersion: "2",
        observation: {
          last_automatic_rollback: {
            target_version: "3",
            rollback_version: "2",
            started_at: "2026-04-17T00:00:00Z",
            finished_at: "2026-04-17T00:01:00Z",
            reason: "health_deadline_exceeded",
          },
        },
      }),
    ).toMatchObject({
      target_version: "3",
      rollback_version: "2",
    });

    expect(
      currentProjectHostAutomaticRollback({
        currentVersion: "3",
        observation: {
          last_automatic_rollback: {
            target_version: "3",
            rollback_version: "2",
            started_at: "2026-04-17T00:00:00Z",
            finished_at: "2026-04-17T00:01:00Z",
            reason: "health_deadline_exceeded",
          },
        },
      }),
    ).toBeUndefined();
  });

  test("suppresses an older failed upgrade op once automatic rollback completed", () => {
    expect(
      shouldSuppressProjectHostFailedOp({
        currentVersion: "2",
        observation: {
          last_automatic_rollback: {
            target_version: "3",
            rollback_version: "2",
            started_at: "2026-04-17T00:01:00Z",
            finished_at: "2026-04-17T00:02:00Z",
            reason: "health_deadline_exceeded",
          },
        },
        op: {
          op_id: "op-1",
          kind: "host-upgrade-software",
          summary: {
            op_id: "op-1",
            status: "failed",
            kind: "host-upgrade-software",
            created_at: "2026-04-17T00:00:00Z",
            updated_at: "2026-04-17T00:01:30Z",
            scope_id: "h",
            scope_type: "host",
            service: "hosts",
            stream_name: "x",
          },
        },
      }),
    ).toBe(true);
  });

  test("does not suppress a newer failed rollout op", () => {
    expect(
      shouldSuppressProjectHostFailedOp({
        currentVersion: "2",
        observation: {
          last_automatic_rollback: {
            target_version: "3",
            rollback_version: "2",
            started_at: "2026-04-17T00:01:00Z",
            finished_at: "2026-04-17T00:02:00Z",
            reason: "health_deadline_exceeded",
          },
        },
        op: {
          op_id: "op-1",
          kind: "host-upgrade-software",
          summary: {
            op_id: "op-1",
            status: "failed",
            kind: "host-upgrade-software",
            created_at: "2026-04-17T00:03:00Z",
            updated_at: "2026-04-17T00:03:30Z",
            scope_id: "h",
            scope_type: "host",
            service: "hosts",
            stream_name: "x",
          },
        },
      }),
    ).toBe(false);
  });

  test("formats rollback reason labels", () => {
    expect(projectHostRollbackReasonLabel("health_deadline_exceeded")).toBe(
      "health deadline exceeded",
    );
  });

  test("shows host-agent restart wait when a candidate is installed but the old daemon is still running", () => {
    expect(
      currentProjectHostRolloutPhase({
        op: {
          op_id: "op-1",
          kind: "host-upgrade-software",
          summary: { status: "running" } as any,
        },
        currentVersion: "ph-v1",
        observation: {
          last_known_good_version: "ph-v1",
          pending_rollout: {
            target_version: "ph-v2",
            previous_version: "ph-v1",
            started_at: "2026-05-05T00:00:00Z",
            deadline_at: "2026-05-05T00:05:00Z",
          },
        },
        deploymentStatus: {
          host_id: "h",
          configured: [],
          effective: [],
          observed_targets: [
            {
              target_type: "artifact",
              target: "project-host",
              desired_version: "ph-v2",
              observed_version_state: "aligned",
              current_version: "ph-v2",
              installed_versions: ["ph-v2", "ph-v1"],
            },
            {
              target_type: "component",
              target: "project-host",
              desired_version: "ph-v2",
              observed_version_state: "drifted",
              running_versions: ["ph-v1"],
            },
          ],
        },
      }),
    ).toEqual({
      label: "Waiting for host-agent to restart project-host",
      owner: "project-host activation",
      deadlineAt: "2026-05-05T00:05:00Z",
    });
  });

  test("shows candidate health evaluation once the candidate process is running", () => {
    expect(
      currentProjectHostRolloutPhase({
        op: {
          op_id: "op-1",
          kind: "host-upgrade-software",
          summary: { status: "running" } as any,
        },
        observation: {
          last_known_good_version: "ph-v1",
          pending_rollout: {
            target_version: "ph-v2",
            previous_version: "ph-v1",
            started_at: "2026-05-05T00:00:00Z",
            deadline_at: "2026-05-05T00:05:00Z",
          },
        },
        deploymentStatus: {
          host_id: "h",
          configured: [],
          effective: [],
          observed_targets: [
            {
              target_type: "component",
              target: "project-host",
              desired_version: "ph-v2",
              observed_version_state: "aligned",
              running_versions: ["ph-v2"],
            },
          ],
        },
      }),
    ).toEqual({
      label: "Candidate running; evaluating health",
      owner: "project-host activation",
      deadlineAt: "2026-05-05T00:05:00Z",
    });
  });

  test("shows managed component alignment after project-host promotion", () => {
    expect(
      currentProjectHostRolloutPhase({
        op: {
          op_id: "op-1",
          kind: "host-upgrade-software",
          summary: { status: "running" } as any,
        },
        observation: {
          last_known_good_version: "ph-v2",
        },
        deploymentStatus: {
          host_id: "h",
          configured: [],
          effective: [],
          observed_targets: [
            {
              target_type: "artifact",
              target: "project-host",
              desired_version: "ph-v2",
              observed_version_state: "aligned",
              current_version: "ph-v2",
              installed_versions: ["ph-v2", "ph-v1"],
            },
            {
              target_type: "component",
              target: "project-host",
              desired_version: "ph-v2",
              observed_version_state: "aligned",
              observed_runtime_state: "running",
              running_versions: ["ph-v2"],
            },
            {
              target_type: "component",
              target: "conat-router",
              desired_version: "ph-v2",
              observed_version_state: "drifted",
              observed_runtime_state: "running",
              running_versions: ["ph-v1"],
            },
          ],
        },
      }),
    ).toEqual({
      label: "Restarting conat router",
      owner: "managed component alignment",
    });
  });

  test("shows artifact installation before project-host activation starts", () => {
    expect(
      currentProjectHostRolloutPhase({
        op: {
          op_id: "op-1",
          kind: "host-upgrade-software",
          summary: { status: "running" } as any,
        },
        deploymentStatus: {
          host_id: "h",
          configured: [],
          effective: [],
          observed_targets: [
            {
              target_type: "artifact",
              target: "project-host",
              desired_version: "ph-v2",
              observed_version_state: "missing",
              current_version: "ph-v1",
              installed_versions: ["ph-v1"],
            },
          ],
        },
      }),
    ).toEqual({
      label: "Downloading/installing artifact",
      owner: "artifact installation",
    });
  });

  test("prefers structured rollout progress from the backend summary when available", () => {
    expect(
      currentProjectHostRolloutPhase({
        op: {
          op_id: "op-1",
          kind: "host-upgrade-software",
          summary: {
            status: "running",
            progress_summary: {
              rollout_phase: "project_host.candidate_health",
              rollout_phase_label: "Candidate running; evaluating health",
              rollout_phase_owner: "project-host activation",
              rollout_deadline_at: "2026-05-05T00:05:00Z",
              rollout_target_version: "ph-v2",
              rollout_observed_version: "ph-v2",
            },
          } as any,
        },
      }),
    ).toEqual({
      label: "Candidate running; evaluating health",
      owner: "project-host activation",
      deadlineAt: "2026-05-05T00:05:00Z",
      targetVersion: "ph-v2",
      observedVersion: "ph-v2",
    });
  });
});
