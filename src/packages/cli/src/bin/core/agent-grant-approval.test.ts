/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  agentGrantApprovalDetails,
  waitForAgentGrantApproval,
} from "./agent-grant-approval";

const requestId = "00000000-0000-4000-8000-000000000003";
const approvalUrl =
  "https://cocalc.test/projects/project-id/vms?agent_grant=" + requestId;

function approvalError(overrides: Record<string, unknown> = {}) {
  return Object.assign(new Error("temporary account approval required"), {
    code: "agent_grant_required",
    request_id: requestId,
    approval_url: approvalUrl,
    expires_at: "2026-08-14T20:00:00.000Z",
    project_id: "project-id",
    ...overrides,
  });
}

test("extracts structured approval details", () => {
  assert.deepEqual(agentGrantApprovalDetails(approvalError()), {
    request_id: requestId,
    approval_url: approvalUrl,
    expires_at: "2026-08-14T20:00:00.000Z",
    project_id: "project-id",
  });
});

test("falls back to the approval URL and request ID in an annotated message", () => {
  const error = new Error(
    `approve request ${requestId} at ${approvalUrl} - callHub: code='agent_grant_required'`,
  );
  assert.deepEqual(agentGrantApprovalDetails(error), {
    request_id: requestId,
    approval_url: approvalUrl,
  });
});

test("announces once and retries until the exact request is approved", async () => {
  const announcements: unknown[] = [];
  let attempts = 0;
  const result = await waitForAgentGrantApproval({
    initialError: approvalError(),
    operation: async () => {
      attempts += 1;
      if (attempts < 2) throw approvalError();
      return "stopped";
    },
    onPending: (details) => announcements.push(details),
    sleep: async () => undefined,
    now: () => Date.parse("2026-08-14T19:00:00.000Z"),
  });
  assert.equal(result, "stopped");
  assert.equal(attempts, 2);
  assert.equal(announcements.length, 1);
});

test("stops retrying when the approval request has expired", async () => {
  let attempts = 0;
  await assert.rejects(
    waitForAgentGrantApproval({
      initialError: approvalError(),
      operation: async () => {
        attempts += 1;
        return "unexpected";
      },
      onPending: () => undefined,
      sleep: async () => undefined,
      now: () => Date.parse("2026-08-14T20:00:00.000Z"),
    }),
    { code: "agent_grant_required" },
  );
  assert.equal(attempts, 0);
});
