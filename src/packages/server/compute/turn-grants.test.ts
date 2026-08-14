/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const query = jest.fn();
const clientQuery = jest.fn();
const release = jest.fn();
const connect = jest.fn(async () => ({ query: clientQuery, release }));
const centralLog = jest.fn(async () => undefined);

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query, connect }),
}));

jest.mock("@cocalc/database/postgres/central-log", () => ({
  __esModule: true,
  default: (...args: any[]) => centralLog(...args),
}));

import {
  approveAgentComputeGrant,
  requireAgentComputeGrant,
  revokeAgentComputeGrant,
} from "./turn-grants";

const account_id = "00000000-0000-4000-8000-000000000001";
const project_id = "00000000-0000-4000-8000-000000000002";
const grant_id = "00000000-0000-4000-8000-000000000003";
const vm_id = "00000000-0000-4000-8000-000000000004";

function auth(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    account_id,
    project_id,
    token_fingerprint: "a".repeat(64),
    issued_at_s: now - 5,
    expires_at_s: now + 600,
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    operation: "start-vm",
    operation_id: "a".repeat(64),
    vm_id,
    provider: "gcp" as const,
    machine_class: "e2-standard-2",
    funding_mode: "account-prepaid",
    active_vms: 1,
    hourly_usd: 0.12,
    total_authorized_usd: 0.24,
    ttl_minutes: 120,
    ...overrides,
  };
}

function approvedGrant(overrides: Record<string, unknown> = {}) {
  const approvedRequest = {
    action: "availability",
    ...request(),
  };
  return {
    grant_id,
    owner_account_id: account_id,
    project_id,
    turn_id: "turn",
    session_id: "session",
    allowed_actions: ["read", "data-plane", "availability"],
    allowed_vm_ids: [vm_id],
    allow_create: false,
    allowed_providers: ["gcp"],
    allowed_machine_classes: ["e2-standard-2"],
    funding_mode: "account-prepaid",
    max_active_vms: 1,
    max_hourly_usd: 0.12,
    max_total_authorized_usd: 0.24,
    max_ttl_minutes: 120,
    metadata: { approved_request: approvedRequest },
    ...overrides,
  };
}

beforeEach(() => {
  query.mockReset();
  clientQuery.mockReset();
  connect.mockClear();
  release.mockClear();
  centralLog.mockClear();
});

it("creates a hash-only read/data-plane grant and touches it", async () => {
  query
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({
      rows: [
        approvedGrant({
          allowed_actions: ["read", "data-plane"],
          allowed_vm_ids: [],
          metadata: {},
        }),
      ],
    })
    .mockResolvedValueOnce({ rows: [] });

  await expect(
    requireAgentComputeGrant({
      auth: auth(),
      action: "read",
      project_id,
    }),
  ).resolves.toBeUndefined();
  expect(query.mock.calls[1][0]).toContain(
    "INSERT INTO compute_vm_turn_grants",
  );
  expect(query.mock.calls[1][1]).toContain("a".repeat(64));
  expect(JSON.stringify(query.mock.calls)).not.toContain("Bearer ");
  expect(centralLog).toHaveBeenCalledWith(
    expect.objectContaining({ event: "managed_compute_agent_grant_used" }),
  );
});

it("records an exact pending mutation request", async () => {
  query
    .mockResolvedValueOnce({ rows: [approvedGrant({ allowed_actions: [] })] })
    .mockResolvedValueOnce({ rows: [] });

  await expect(
    requireAgentComputeGrant({
      auth: auth(),
      action: "availability",
      project_id,
      vm_id,
      request: request(),
    }),
  ).rejects.toMatchObject({ code: "agent_grant_required", grant_id });
  expect(query.mock.calls[1][1][1].pending_request).toMatchObject({
    action: "availability",
    operation: "start-vm",
    operation_id: "a".repeat(64),
    vm_id,
    total_authorized_usd: 0.24,
  });
  expect(centralLog).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "managed_compute_agent_grant_requested",
    }),
  );
});

it("requires exact operation identity and enforces the approved envelope", async () => {
  query.mockResolvedValueOnce({ rows: [approvedGrant()] });
  await expect(
    requireAgentComputeGrant({
      auth: auth(),
      action: "availability",
      project_id,
      vm_id,
      request: request({ operation_id: "b".repeat(64) }),
    }),
  ).rejects.toMatchObject({ code: "agent_grant_required" });

  query.mockReset();
  query.mockResolvedValueOnce({ rows: [approvedGrant()] });
  await expect(
    requireAgentComputeGrant({
      auth: auth(),
      action: "availability",
      project_id,
      vm_id,
      request: request({ hourly_usd: 0.13 }),
    }),
  ).rejects.toThrow("hourly cost envelope exceeded");
});

it("authorizes the exact approved mutation and records its use", async () => {
  query
    .mockResolvedValueOnce({ rows: [approvedGrant()] })
    .mockResolvedValueOnce({ rows: [] });
  await expect(
    requireAgentComputeGrant({
      auth: auth(),
      action: "availability",
      project_id,
      vm_id,
      request: request(),
    }),
  ).resolves.toBeUndefined();
  expect(centralLog).toHaveBeenCalledWith(
    expect.objectContaining({ event: "managed_compute_agent_grant_used" }),
  );
});

it("approves a pending request transactionally", async () => {
  const pending = {
    action: "availability",
    ...request(),
  };
  const updated = approvedGrant();
  clientQuery
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({
      rows: [
        {
          ...approvedGrant(),
          expires_at: new Date(Date.now() + 600_000),
          metadata: { pending_request: pending },
        },
      ],
    })
    .mockResolvedValueOnce({ rows: [updated] })
    .mockResolvedValueOnce({ rows: [] });

  await expect(
    approveAgentComputeGrant({ account_id, grant_id }),
  ).resolves.toEqual(updated);
  expect(
    clientQuery.mock.calls.map(([sql]) => sql.trim().split(/\s+/)[0]),
  ).toEqual(["BEGIN", "SELECT", "UPDATE", "COMMIT"]);
  expect(release).toHaveBeenCalled();
});

it("rejects expired, cross-project, and malformed mutation capabilities", async () => {
  await expect(
    requireAgentComputeGrant({
      auth: auth({ expires_at_s: 1 }),
      action: "read",
      project_id,
    }),
  ).rejects.toThrow("expired");
  await expect(
    requireAgentComputeGrant({
      auth: auth(),
      action: "read",
      project_id: "00000000-0000-4000-8000-000000000099",
    }),
  ).rejects.toThrow("cross projects");
  await expect(
    requireAgentComputeGrant({
      auth: auth(),
      action: "billable",
      project_id,
      request: {},
    }),
  ).rejects.toThrow("operation identity");
});

it("revokes only the owner's grant", async () => {
  query.mockResolvedValueOnce({ rows: [] });
  await revokeAgentComputeGrant({ account_id, grant_id });
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("revoked_at=NOW()"),
    [grant_id, account_id],
  );
});
