import {
  automationRecordFromThreadProjection,
  normalizeAcpAutomationRecord,
} from "../index";

describe("ACP automation projection recovery", () => {
  it("reconstructs the durable scheduler record", () => {
    expect(
      automationRecordFromThreadProjection({
        project_id: "project-1",
        path: "repo/agent.chat",
        thread_id: "thread-1",
        account_id: "account-1",
        updated_at: "2026-09-17T20:00:00.000Z",
        automation_config: {
          automation_id: "automation-1",
          enabled: true,
          title: "Review pull requests",
          prompt: "Review all open pull requests",
          schedule_type: "interval",
          interval_minutes: 240,
          timezone: "America/Los_Angeles",
        },
        automation_state: {
          automation_id: "automation-1",
          status: "active",
          next_run_at_ms: 1234,
          unacknowledged_runs: 2,
        },
      }),
    ).toEqual({
      automation_id: "automation-1",
      project_id: "project-1",
      path: "repo/agent.chat",
      thread_id: "thread-1",
      account_id: "account-1",
      enabled: true,
      title: "Review pull requests",
      prompt: "Review all open pull requests",
      schedule_type: "interval",
      interval_minutes: 240,
      timezone: "America/Los_Angeles",
      status: "active",
      next_run_at_ms: 1234,
      unacknowledged_runs: 2,
      updated_at: "2026-09-17T20:00:00.000Z",
    });
  });

  it("preserves command automation settings", () => {
    const record = automationRecordFromThreadProjection({
      project_id: "project-1",
      path: "repo/agent.chat",
      thread_id: "thread-1",
      account_id: "account-1",
      automation_config: {
        automation_id: "automation-1",
        enabled: true,
        title: "Check repository",
        run_kind: "command",
        command: "git status --short",
        command_cwd: "/home/user/repo",
        command_timeout_ms: 90_000,
        command_max_output_bytes: 250_000,
        schedule_type: "daily",
        local_time: "07:00",
        timezone: "UTC",
      },
    });
    expect(record).toEqual(
      expect.objectContaining({
        run_kind: "command",
        command: "git status --short",
        command_cwd: "/home/user/repo",
        command_timeout_ms: 90_000,
        command_max_output_bytes: 250_000,
      }),
    );
    expect(normalizeAcpAutomationRecord(record)).toEqual(
      expect.objectContaining({
        run_kind: "command",
        command: "git status --short",
        command_cwd: "/home/user/repo",
        command_timeout_ms: 90_000,
        command_max_output_bytes: 250_000,
      }),
    );
  });

  it("does not trust extra authority fields in projection values", () => {
    const record = automationRecordFromThreadProjection({
      project_id: "project-1",
      path: "repo/agent.chat",
      thread_id: "thread-1",
      account_id: "account-1",
      automation_config: {
        automation_id: "automation-1",
        enabled: true,
        prompt: "Review pull requests",
        schedule_type: "daily",
        local_time: "07:00",
        timezone: "UTC",
        project_id: "attacker-project",
      } as any,
      automation_state: {
        automation_id: "automation-1",
        status: "active",
        account_id: "attacker-account",
        prompt: "hostile replacement",
      } as any,
    });

    expect(record).toEqual(
      expect.objectContaining({
        project_id: "project-1",
        account_id: "account-1",
        path: "repo/agent.chat",
        prompt: "Review pull requests",
      }),
    );
    expect(record?.project_id).not.toBe("attacker-project");
    expect(record?.account_id).not.toBe("attacker-account");
    expect(record?.prompt).not.toBe("hostile replacement");
  });

  it("refuses a projection without a stable automation id", () => {
    expect(
      automationRecordFromThreadProjection({
        project_id: "project-1",
        path: "repo/agent.chat",
        thread_id: "thread-1",
        account_id: "account-1",
        automation_config: { enabled: true },
      }),
    ).toBeUndefined();
  });
});
