import {
  automationRecordFromThreadProjection,
  normalizeAcpAutomationRecord,
  recoveredAutomationRequiresActiveAdmission,
} from "../index";

describe("ACP automation projection recovery", () => {
  it("reconstructs the durable scheduler record", () => {
    expect(
      automationRecordFromThreadProjection({
        project_id: "project-1",
        path: "repo/agent.chat",
        thread_id: "thread-1",
        account_id: "account-1",
        settings_revision: "revision-1",
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
      settings_revision: "revision-1",
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
      settings_revision: "revision-1",
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
      settings_revision: "revision-1",
      automation_config: {
        automation_id: "automation-1",
        enabled: true,
        prompt: "Review pull requests",
        schedule_type: "daily",
        local_time: "07:00",
        timezone: "UTC",
        project_id: "attacker-project",
        settings_revision: "attacker-revision",
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
    expect(record?.settings_revision).toBe("revision-1");
    expect(record?.prompt).not.toBe("hostile replacement");
  });

  it("refuses a projection without a stable automation id", () => {
    expect(
      automationRecordFromThreadProjection({
        project_id: "project-1",
        path: "repo/agent.chat",
        thread_id: "thread-1",
        account_id: "account-1",
        settings_revision: "revision-1",
        automation_config: { enabled: true },
      }),
    ).toBeUndefined();
  });

  it("requires an authoritative settings revision", () => {
    expect(
      automationRecordFromThreadProjection({
        project_id: "project-1",
        path: "repo/agent.chat",
        thread_id: "thread-1",
        account_id: "account-1",
        settings_revision: "",
        automation_config: {
          automation_id: "automation-1",
          enabled: true,
        },
      }),
    ).toBeUndefined();
  });

  it("requires active-limit admission before restoring enabled schedules", () => {
    const base = {
      automation_id: "automation-1",
      project_id: "project-1",
      path: "repo/agent.chat",
      thread_id: "thread-1",
      account_id: "account-1",
      settings_revision: "revision-1",
      enabled: true,
      title: null,
      run_kind: "codex" as const,
      prompt: "Review pull requests",
      command: null,
      command_cwd: null,
      command_timeout_ms: null,
      command_max_output_bytes: null,
      schedule_type: "daily" as const,
      days_of_week: null,
      local_time: "07:00",
      interval_minutes: null,
      window_start_local_time: null,
      window_end_local_time: null,
      timezone: "UTC",
      pause_after_unacknowledged_runs: 7,
      next_run_at: 1234,
      last_run_started_at: null,
      last_run_finished_at: null,
      last_acknowledged_at: null,
      unacknowledged_runs: 0,
      paused_reason: null,
      last_error: null,
      last_job_op_id: null,
      last_message_id: null,
      created_at: 1234,
      updated_at: 1234,
    };
    for (const status of ["active", "running", "error"] as const) {
      expect(
        recoveredAutomationRequiresActiveAdmission({ ...base, status }),
      ).toBe(true);
    }
    expect(
      recoveredAutomationRequiresActiveAdmission({
        ...base,
        status: "paused",
      }),
    ).toBe(false);
    expect(
      recoveredAutomationRequiresActiveAdmission({
        ...base,
        enabled: false,
        status: "active",
      }),
    ).toBe(false);
  });
});
