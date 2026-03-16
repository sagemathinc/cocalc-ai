/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { getDatabase, initDatabase } from "../../sqlite/database";
import {
  deleteAcpAutomationsForProject,
  listAcpAutomationsForProject,
  toAutomationRecord,
  upsertAcpAutomation,
} from "../../sqlite/acp-automations";

describe("ACP automation sqlite lifecycle", () => {
  beforeAll(() => {
    initDatabase({ filename: ":memory:" });
  });

  beforeEach(() => {
    deleteAcpAutomationsForProject("project-1");
    deleteAcpAutomationsForProject("project-2");
    getDatabase().prepare("DELETE FROM acp_automations").run();
  });

  it("serializes enough data to rebuild the local scheduler index", () => {
    const row = upsertAcpAutomation({
      automation_id: "automation-1",
      project_id: "project-1",
      path: "/root/daily.chat",
      thread_id: "thread-1",
      account_id: "account-1",
      enabled: true,
      title: "Daily status",
      prompt: "Tell me what changed.",
      schedule_type: "daily",
      local_time: "05:00",
      timezone: "America/Los_Angeles",
      pause_after_unacknowledged_runs: 7,
      status: "active",
      next_run_at: 101,
      last_run_started_at: 91,
      last_run_finished_at: 99,
      last_acknowledged_at: 88,
      unacknowledged_runs: 2,
      paused_reason: null,
      last_error: null,
      last_job_op_id: "job-1",
      last_message_id: "message-1",
      created_at: 10,
      updated_at: 20,
    });

    expect(toAutomationRecord(row)).toEqual({
      automation_id: "automation-1",
      project_id: "project-1",
      path: "/root/daily.chat",
      thread_id: "thread-1",
      account_id: "account-1",
      title: "Daily status",
      prompt: "Tell me what changed.",
      schedule_type: "daily",
      local_time: "05:00",
      timezone: "America/Los_Angeles",
      pause_after_unacknowledged_runs: 7,
      status: "active",
      enabled: true,
      next_run_at_ms: 101,
      last_run_started_at_ms: 91,
      last_run_finished_at_ms: 99,
      last_acknowledged_at_ms: 88,
      unacknowledged_runs: 2,
      paused_reason: undefined,
      last_error: undefined,
      last_job_op_id: "job-1",
      last_message_id: "message-1",
      created_at: new Date(10).toISOString(),
      updated_at: new Date(20).toISOString(),
    });
  });

  it("cleans all automation rows for a removed project", () => {
    upsertAcpAutomation({
      automation_id: "automation-1",
      project_id: "project-1",
      path: "/root/a.chat",
      thread_id: "thread-1",
      account_id: "account-1",
      enabled: true,
      title: "A",
      prompt: "A",
      schedule_type: "daily",
      local_time: "05:00",
      timezone: "America/Los_Angeles",
      pause_after_unacknowledged_runs: 7,
      status: "active",
      next_run_at: 101,
      unacknowledged_runs: 0,
      created_at: 10,
      updated_at: 20,
    });
    upsertAcpAutomation({
      automation_id: "automation-2",
      project_id: "project-1",
      path: "/root/b.chat",
      thread_id: "thread-2",
      account_id: "account-1",
      enabled: false,
      title: "B",
      prompt: "B",
      schedule_type: "daily",
      local_time: "06:00",
      timezone: "America/Los_Angeles",
      pause_after_unacknowledged_runs: 7,
      status: "paused",
      next_run_at: null,
      paused_reason: "user_paused",
      unacknowledged_runs: 0,
      created_at: 10,
      updated_at: 20,
    });
    upsertAcpAutomation({
      automation_id: "automation-3",
      project_id: "project-2",
      path: "/root/c.chat",
      thread_id: "thread-3",
      account_id: "account-2",
      enabled: true,
      title: "C",
      prompt: "C",
      schedule_type: "daily",
      local_time: "07:00",
      timezone: "America/Los_Angeles",
      pause_after_unacknowledged_runs: 7,
      status: "active",
      next_run_at: 303,
      unacknowledged_runs: 0,
      created_at: 10,
      updated_at: 20,
    });

    deleteAcpAutomationsForProject("project-1");

    expect(listAcpAutomationsForProject("project-1")).toEqual([]);
    expect(listAcpAutomationsForProject("project-2")).toHaveLength(1);
  });
});
