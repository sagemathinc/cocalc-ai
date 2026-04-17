import {
  currentProjectHostAutomaticRollback,
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
});
