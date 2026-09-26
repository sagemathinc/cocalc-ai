/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { buildExamBrowserBootstrap } from "./browser-bootstrap";

describe("exam browser bootstrap", () => {
  it("returns only the account and project fields needed by the student UI", () => {
    const bootstrap = buildExamBrowserBootstrap({
      session: {
        account_id: "account-1",
        project_id: "project-1",
        run_id: "run-1",
        expires_at_ms: 1234,
        scheduled_stop_at_ms: 1000,
      },
      account: {
        first_name: "Exam",
        last_name: "Student",
        email_address: "must-not-leak@example.test",
        usage_account_id: "owner-account",
      },
      project: {
        title: "Scratchpad",
        state: { state: "running", secret: "must-not-leak" },
        secret_token: "must-not-leak",
        authorized_keys: "must-not-leak",
        users: { instructor: { group: "owner" } },
      },
    });

    expect(bootstrap).toEqual({
      delete_at: "1970-01-01T00:00:01.000Z",
      account: {
        account_id: "account-1",
        first_name: "Exam",
        last_name: "Student",
        display_name: "Exam User",
        editor_settings: {},
        other_settings: {},
        groups: [],
        terminal: {},
        ephemeral: 1234,
      },
      project: {
        project_id: "project-1",
        title: "Scratchpad",
        description: "",
        users: { "account-1": { group: "owner" } },
        state: { state: "running" },
        local_only: true,
        exam_mode: true,
        exam_run_id: "run-1",
      },
    });
  });

  it("passes the exam project's course restrictions to the student UI", () => {
    // The empty-folder panel and the terminal read these through
    // useStudentProjectFunctionality; dropping them would re-offer Terminal
    // and Upload in every exam.
    const student_project_functionality = {
      disableTerminals: true,
      disableUploads: true,
      disableCollaborators: true,
    };
    const bootstrap = buildExamBrowserBootstrap({
      session: {
        account_id: "account-1",
        project_id: "project-1",
        run_id: "run-1",
        expires_at_ms: 1234,
        scheduled_stop_at_ms: 1000,
      },
      project: {
        title: "Scratchpad",
        course: { student_project_functionality },
      },
    });
    expect(bootstrap.project.course).toEqual({ student_project_functionality });
  });

  it("does not advertise an automatic deletion time in manual mode", () => {
    const bootstrap = buildExamBrowserBootstrap({
      session: {
        account_id: "account-1",
        project_id: "project-1",
        run_id: "run-1",
        expires_at_ms: 1234,
        scheduled_stop_at_ms: 1000,
        cleanup_mode: "manual",
      },
    });
    expect(bootstrap.delete_at).toBeUndefined();
  });
});
