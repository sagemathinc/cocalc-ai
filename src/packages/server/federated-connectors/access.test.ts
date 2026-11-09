/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Assignments, shared-project approvals, the owning-bay snapshot and their
// audit rows, against a real (ephemeral) database. Fake values only.

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { ensureFederatedConnectorGuards } from "@cocalc/database/postgres/schema/federated-connector-guards";

const BAY = "bay-a";
let bay = BAY;
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => bay,
}));

const SESSION = {
  session_hash: "fake-session-hash-value",
  account_id: "",
  factor_verified_at: new Date("2026-11-09T05:00:00Z"),
};
const freshAuth = jest.fn(async (_opts: any) => SESSION);
jest.mock("@cocalc/server/conat/api/dangerous-session-auth", () => ({
  requireDangerousSessionAuth: (opts: any) => freshAuth(opts),
}));
const authorizeConfigChange = jest.fn(async (_opts: any) => SESSION);
jest.mock("@cocalc/server/agents/cocalc-connector-config", () => ({
  assertAccountHome: async () => undefined,
  authorizeConfigChange: (opts: any) => authorizeConfigChange(opts),
}));
const sendMessage = jest.fn(async (_opts: any) => 1);
jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: (opts: any) => sendMessage(opts),
}));

import { setFederatedAuditSessionKeyForTesting } from "./audit";
import {
  removeFederatedConnectorAssignment,
  saveFederatedConnectorAssignment,
} from "./assignments";
import {
  approveFederatedSharedProjectOnOwningBay,
  federationSnapshotOnOwningBay,
  isSharedProject,
  revokeFederatedSharedProjectApprovalsForRehome,
  revokeFederatedSharedProjectOnOwningBay,
} from "./approvals";

const UUID = (n: number) =>
  `00000000-0000-4000-8000-${`${n}`.padStart(12, "0")}`;
const ACCOUNT = UUID(1);
const OWNER = UUID(2);
const OTHER = UUID(3);
const AGENT = UUID(4);
const PROJECT = UUID(5);
const SOLO = UUID(6);
const CONNECTION = UUID(9);
const GRANT = UUID(7);
const GRANT2 = UUID(8);
const FOREIGN_GRANT = UUID(10);

const q = (sql: string, params: any[] = []) => getPool().query(sql, params);

async function insertGrant(
  grant_id: string,
  account_id: string,
  state: string,
) {
  await q(
    `INSERT INTO federated_connector_grants
       (grant_id, connection_id, account_id, revision, service_account,
        sa_label, target_project, permission_profile, state)
     VALUES ($1, $2, $3, 1, 'reader-sa@example-project-1.iam.gserviceaccount.com',
             'read-only', 'example-project-1', 'read-only', $4)`,
    [grant_id, CONNECTION, account_id, state],
  );
}

async function insertProject(project_id: string, users: object) {
  await q(
    `INSERT INTO projects (project_id, title, users, owning_bay_id)
     VALUES ($1, 'Fake', $2, $3)`,
    [project_id, users, BAY],
  );
}

async function openLease(assignment_id: string, revision: number) {
  const lease_id = UUID(100 + Math.floor(Math.random() * 1e6));
  await q(
    `INSERT INTO federated_connector_turn_leases
       (lease_id, account_id, agent_id, source_project_id, run_id, turn_key,
        host_id, assignment_id, assignment_revision, grant_id, grant_revision)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1)`,
    [
      lease_id,
      ACCOUNT,
      AGENT,
      PROJECT,
      UUID(50),
      lease_id.replace(/-/g, "").padEnd(64, "0"),
      UUID(51),
      assignment_id,
      revision,
      GRANT,
    ],
  );
  return lease_id;
}

async function leaseEnd(lease_id: string) {
  const { rows } = await q(
    `SELECT end_reason FROM federated_connector_turn_leases WHERE lease_id=$1`,
    [lease_id],
  );
  return rows[0]?.end_reason ?? null;
}

async function audits() {
  const { rows } = await q(
    `SELECT * FROM federated_connector_assignment_audit ORDER BY time`,
  );
  return rows;
}

beforeAll(async () => {
  await initEphemeralDatabase({});
  const client = await getPool().connect();
  try {
    await ensureFederatedConnectorGuards(
      client,
      new Set([
        "federated_connector_assignment_audit",
        "federated_connector_turn_leases",
        "federated_connector_shared_project_approvals",
      ]),
    );
  } finally {
    client.release();
  }
  setFederatedAuditSessionKeyForTesting(Buffer.alloc(32, 7));
  await q(
    `INSERT INTO federated_connector_connections
       (connection_id, account_id, provider, use_case, state)
     VALUES ($1, $2, 'gcp', 'ops', 'enabled')`,
    [CONNECTION, ACCOUNT],
  );
  await insertGrant(GRANT, ACCOUNT, "enabled");
  await insertGrant(GRANT2, ACCOUNT, "enabled");
  await insertGrant(FOREIGN_GRANT, OTHER, "enabled");
  await insertProject(PROJECT, {
    [OWNER]: { group: "owner" },
    [ACCOUNT]: { group: "collaborator" },
  });
  await insertProject(SOLO, { [ACCOUNT]: { group: "owner" } });
}, 30_000);

afterAll(async () => {
  await getPool().end();
});

beforeEach(() => {
  bay = BAY;
  sendMessage.mockClear();
});

describe("assignments", () => {
  let revision = 0;
  let assignment_id = "";

  it("assigns with fresh auth and writes a keyed-session audit row", async () => {
    const saved = await saveFederatedConnectorAssignment({
      account_id: ACCOUNT,
      session_hash: "ignored-by-mock",
      agent_id: AGENT,
      source_project_id: PROJECT,
      grant_id: GRANT,
      enabled: true,
    });
    revision = saved.revision;
    assignment_id = saved.assignment_id;
    expect(saved).toMatchObject({
      grant_id: GRANT,
      enabled: true,
      revision: 1,
    });
    expect(authorizeConfigChange).toHaveBeenCalled();
    const [row] = await audits();
    expect(row).toMatchObject({
      action: "assign",
      actor_account_id: ACCOUNT,
      assignment_id,
      before: null,
      after: { grant_id: GRANT, enabled: true, revision: 1 },
    });
    expect(row.session_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(SESSION.session_hash);
    expect(row.fresh_auth_at.toISOString()).toBe("2026-11-09T05:00:00.000Z");
    // The owner is told, with no ids.
    const message = sendMessage.mock.calls[0][0];
    expect(message.to_ids).toEqual([ACCOUNT]);
    const body = `${message.subject}\n${message.body}`;
    for (const id of [ACCOUNT, AGENT, PROJECT, GRANT, assignment_id]) {
      expect(body).not.toContain(id);
    }
  });

  it("refuses a second assignment for the same agent and project", async () => {
    await expect(
      saveFederatedConnectorAssignment({
        account_id: ACCOUNT,
        agent_id: AGENT,
        source_project_id: PROJECT,
        grant_id: GRANT2,
        enabled: true,
      }),
    ).rejects.toThrow(/settings changed/);
  });

  it("refuses another account's grant and a stale revision", async () => {
    await expect(
      saveFederatedConnectorAssignment({
        account_id: ACCOUNT,
        agent_id: AGENT,
        source_project_id: PROJECT,
        grant_id: FOREIGN_GRANT,
        enabled: true,
        expected_revision: revision,
      }),
    ).rejects.toThrow(/grant is unavailable/);
    await expect(
      saveFederatedConnectorAssignment({
        account_id: ACCOUNT,
        agent_id: AGENT,
        source_project_id: PROJECT,
        grant_id: GRANT2,
        enabled: true,
        expected_revision: revision + 5,
      }),
    ).rejects.toThrow(/settings changed/);
  });

  it("changing the grant ends the open lease with revision, atomically audited", async () => {
    const lease = await openLease(assignment_id, revision);
    const saved = await saveFederatedConnectorAssignment({
      account_id: ACCOUNT,
      agent_id: AGENT,
      source_project_id: PROJECT,
      grant_id: GRANT2,
      enabled: true,
      expected_revision: revision,
    });
    revision = saved.revision;
    expect(revision).toBe(2);
    expect(await leaseEnd(lease)).toBe("revision");
    const last = (await audits()).at(-1);
    expect(last).toMatchObject({
      action: "change",
      before: { grant_id: GRANT, revision: 1 },
      after: { grant_id: GRANT2, revision: 2 },
    });
  });

  it("disabling needs fresh auth but not membership, and ends leases", async () => {
    authorizeConfigChange.mockClear();
    freshAuth.mockClear();
    const lease = await openLease(assignment_id, revision);
    const saved = await saveFederatedConnectorAssignment({
      account_id: ACCOUNT,
      agent_id: AGENT,
      source_project_id: PROJECT,
      grant_id: GRANT2,
      enabled: false,
      expected_revision: revision,
    });
    revision = saved.revision;
    expect(authorizeConfigChange).not.toHaveBeenCalled();
    expect(freshAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: ACCOUNT,
        require_second_factor: true,
      }),
    );
    expect(await leaseEnd(lease)).toBe("revision");
    expect((await audits()).at(-1)?.action).toBe("disable");
  });

  it("refuses without fresh auth, changing nothing", async () => {
    freshAuth.mockRejectedValueOnce(new Error("fresh authentication required"));
    const before = (await audits()).length;
    await expect(
      removeFederatedConnectorAssignment({
        account_id: ACCOUNT,
        agent_id: AGENT,
        source_project_id: PROJECT,
        expected_revision: revision,
      }),
    ).rejects.toThrow(/fresh authentication/);
    expect((await audits()).length).toBe(before);
  });

  it("an audit failure applies nothing", async () => {
    await q(
      `ALTER TABLE federated_connector_assignment_audit ADD CONSTRAINT fail_all CHECK (false) NOT VALID`,
    );
    try {
      await expect(
        removeFederatedConnectorAssignment({
          account_id: ACCOUNT,
          agent_id: AGENT,
          source_project_id: PROJECT,
          expected_revision: revision,
        }),
      ).rejects.toThrow();
    } finally {
      await q(
        `ALTER TABLE federated_connector_assignment_audit DROP CONSTRAINT fail_all`,
      );
    }
    const { rows } = await q(
      `SELECT revision FROM federated_connector_agent_grants WHERE assignment_id=$1`,
      [assignment_id],
    );
    expect(rows[0]?.revision).toBe(revision);
  });

  it("removes at the revision seen, ending leases", async () => {
    const lease = await openLease(assignment_id, revision);
    await removeFederatedConnectorAssignment({
      account_id: ACCOUNT,
      agent_id: AGENT,
      source_project_id: PROJECT,
      expected_revision: revision,
    });
    expect(await leaseEnd(lease)).toBe("revision");
    const last = (await audits()).at(-1);
    expect(last).toMatchObject({ action: "remove", after: null });
  });
});

describe("shared-project approvals and the snapshot", () => {
  it("a single-user project isn't shared", async () => {
    const snap = await federationSnapshotOnOwningBay({
      project_id: SOLO,
      account_id: ACCOUNT,
    });
    expect(snap).toMatchObject({
      account_role: "owner",
      other_members: 0,
      pending_invites: 0,
      approval_id: null,
    });
    expect(isSharedProject(snap)).toBe(false);
  });

  it("other members of any role, and pending invites, make it shared", async () => {
    const snap = await federationSnapshotOnOwningBay({
      project_id: PROJECT,
      account_id: ACCOUNT,
    });
    expect(snap).toMatchObject({
      account_role: "collaborator",
      other_members: 1,
    });
    expect(isSharedProject(snap)).toBe(true);
    // Counts only: no member ids.
    expect(JSON.stringify(snap)).not.toContain(OWNER);

    await q(
      `INSERT INTO project_collab_invites (invite_id, project_id, inviter_account_id, status, created, updated)
       VALUES ($1, $2, $3, 'pending', NOW(), NOW())`,
      [UUID(60), SOLO, ACCOUNT],
    );
    const solo = await federationSnapshotOnOwningBay({
      project_id: SOLO,
      account_id: ACCOUNT,
    });
    expect(solo.pending_invites).toBe(1);
    expect(isSharedProject(solo)).toBe(true);
    await q(
      `UPDATE project_collab_invites SET status='expired' WHERE invite_id=$1`,
      [UUID(60)],
    );
  });

  it("only a current owner can approve; the account can't approve itself", async () => {
    await expect(
      approveFederatedSharedProjectOnOwningBay({
        account_id: ACCOUNT,
        project_id: PROJECT,
        approved_account_id: ACCOUNT,
      }),
    ).rejects.toThrow(/only a project owner/);
    await expect(
      approveFederatedSharedProjectOnOwningBay({
        account_id: OWNER,
        project_id: PROJECT,
        approved_account_id: OTHER,
      }),
    ).rejects.toThrow(/not a collaborator/);
  });

  it("refuses on a bay that doesn't own the project", async () => {
    bay = "bay-b";
    await expect(
      approveFederatedSharedProjectOnOwningBay({
        account_id: OWNER,
        project_id: PROJECT,
        approved_account_id: ACCOUNT,
      }),
    ).rejects.toThrow(/not owned by this bay/);
    await expect(
      federationSnapshotOnOwningBay({
        project_id: PROJECT,
        account_id: ACCOUNT,
      }),
    ).rejects.toThrow(/not owned by this bay/);
  });

  it("an owner's approval counts while the approver stays an owner", async () => {
    const { approval_id } = await approveFederatedSharedProjectOnOwningBay({
      account_id: OWNER,
      project_id: PROJECT,
      approved_account_id: ACCOUNT,
    });
    let snap = await federationSnapshotOnOwningBay({
      project_id: PROJECT,
      account_id: ACCOUNT,
    });
    expect(snap.approval_id).toBe(approval_id);
    expect((await audits()).at(-1)).toMatchObject({
      action: "shared-approve",
      actor_account_id: OWNER,
      approval_id,
    });

    // The approver is demoted: the approval no longer counts.
    await q(`UPDATE projects SET users = users || $2 WHERE project_id=$1`, [
      PROJECT,
      { [OWNER]: { group: "collaborator" }, [OTHER]: { group: "owner" } },
    ]);
    snap = await federationSnapshotOnOwningBay({
      project_id: PROJECT,
      account_id: ACCOUNT,
    });
    expect(snap.approval_id).toBeNull();
    await q(`UPDATE projects SET users = users || $2 WHERE project_id=$1`, [
      PROJECT,
      { [OWNER]: { group: "owner" } },
    ]);
    snap = await federationSnapshotOnOwningBay({
      project_id: PROJECT,
      account_id: ACCOUNT,
    });
    expect(snap.approval_id).toBe(approval_id);
  });

  it("the approved account can withdraw it; another non-owner can't", async () => {
    await q(`UPDATE projects SET users = users || $2 WHERE project_id=$1`, [
      PROJECT,
      { [OTHER]: { group: "collaborator" } },
    ]);
    await expect(
      revokeFederatedSharedProjectOnOwningBay({
        account_id: OTHER,
        project_id: PROJECT,
        approved_account_id: ACCOUNT,
      }),
    ).rejects.toThrow(/only a project owner/);
    await revokeFederatedSharedProjectOnOwningBay({
      account_id: ACCOUNT,
      project_id: PROJECT,
      approved_account_id: ACCOUNT,
    });
    const snap = await federationSnapshotOnOwningBay({
      project_id: PROJECT,
      account_id: ACCOUNT,
    });
    expect(snap.approval_id).toBeNull();
    expect((await audits()).at(-1)).toMatchObject({
      action: "shared-revoke",
      actor_account_id: ACCOUNT,
    });
  });

  it("a rehome away and back (A to B to A) needs a new approval", async () => {
    const { approval_id } = await approveFederatedSharedProjectOnOwningBay({
      account_id: OWNER,
      project_id: PROJECT,
      approved_account_id: ACCOUNT,
    });
    // Leaving A: the flip and the revocation in one transaction, as in
    // projects/rehome.ts.
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE projects SET owning_bay_id='bay-b' WHERE project_id=$1`,
        [PROJECT],
      );
      expect(
        await revokeFederatedSharedProjectApprovalsForRehome(client, PROJECT),
      ).toBe(1);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    // ... and back to A.
    await q(`UPDATE projects SET owning_bay_id=$2 WHERE project_id=$1`, [
      PROJECT,
      BAY,
    ]);
    const snap = await federationSnapshotOnOwningBay({
      project_id: PROJECT,
      account_id: ACCOUNT,
    });
    expect(isSharedProject(snap)).toBe(true);
    expect(snap.approval_id).toBeNull();
    const { rows } = await q(
      `SELECT revoke_reason, revoked_by FROM federated_connector_shared_project_approvals WHERE approval_id=$1`,
      [approval_id],
    );
    expect(rows[0]).toEqual({ revoke_reason: "rehome", revoked_by: null });
  });
});
