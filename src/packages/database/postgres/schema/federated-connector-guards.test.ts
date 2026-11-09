/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { uuid } from "@cocalc/util/misc";
import {
  FEDERATED_CONNECTOR_GUARDS,
  ensureFederatedConnectorGuards,
  federatedConnectorGuardsNeedSync,
  getFederatedConnectorGuardStatus,
  purgeExpiredFederatedConnectorRecords,
} from "./federated-connector-guards";

const AUDIT = "federated_connector_assignment_audit";
const LEASES = "federated_connector_turn_leases";
const APPROVALS = "federated_connector_shared_project_approvals";
const TABLES = new Set([AUDIT, LEASES, APPROVALS]);

beforeAll(async () => {
  await initEphemeralDatabase({});
  const client = await getPool().connect();
  try {
    await ensureFederatedConnectorGuards(client, TABLES);
  } finally {
    client.release();
  }
}, 15_000);

afterAll(async () => {
  await testCleanup();
});

const q = (sql: string, params: any[] = []) => getPool().query(sql, params);

function guardTrigger(table: string): string {
  const guard = FEDERATED_CONNECTOR_GUARDS.find((g) => g.table === table)!;
  return guard.triggers[0].name;
}

// Test-only: change a row with its guard disabled (to age it).
async function unguarded(table: string, sql: string, params: any[]) {
  const trigger = guardTrigger(table);
  await q(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
  try {
    await q(sql, params);
  } finally {
    await q(`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${trigger}`);
  }
}

async function insertAudit(): Promise<string> {
  const id = uuid();
  await q(
    `INSERT INTO ${AUDIT} (id, time, action, actor_account_id, account_id, before, after)
     VALUES ($1, NOW() - INTERVAL '20 months', 'assign', $2, $2, '{}', '{"grant_revision":1}')`,
    [id, uuid()],
  );
  return id;
}

async function insertLease(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const row = {
    lease_id: uuid(),
    account_id: uuid(),
    agent_id: uuid(),
    source_project_id: uuid(),
    run_id: uuid(),
    turn_key: "a".repeat(64),
    host_id: uuid(),
    assignment_id: uuid(),
    assignment_revision: 1,
    grant_id: uuid(),
    grant_revision: 1,
    ...overrides,
  };
  const cols = Object.keys(row);
  await q(
    `INSERT INTO ${LEASES} (${cols.join(",")})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
    Object.values(row),
  );
  return row.lease_id as string;
}

async function lease(lease_id: string) {
  const { rows } = await q(`SELECT * FROM ${LEASES} WHERE lease_id=$1`, [
    lease_id,
  ]);
  return rows[0];
}

async function insertApproval(): Promise<string> {
  const approval_id = uuid();
  await q(
    `INSERT INTO ${APPROVALS} (approval_id, project_id, account_id, approver_account_id)
     VALUES ($1, $2, $3, $4)`,
    [approval_id, uuid(), uuid(), uuid()],
  );
  return approval_id;
}

describe("guard status", () => {
  it("reports ok for every table after ensure, and nothing to sync", async () => {
    for (const table of TABLES) {
      expect(await getFederatedConnectorGuardStatus(getPool(), table)).toBe(
        "ok",
      );
    }
    expect(await federatedConnectorGuardsNeedSync(getPool(), TABLES)).toBe(
      false,
    );
  });

  it("reports a disabled trigger and does not re-enable it", async () => {
    const trigger = guardTrigger(LEASES);
    await q(`ALTER TABLE ${LEASES} DISABLE TRIGGER ${trigger}`);
    try {
      expect(await getFederatedConnectorGuardStatus(getPool(), LEASES)).toBe(
        "disabled",
      );
      const client = await getPool().connect();
      try {
        await ensureFederatedConnectorGuards(client, TABLES);
      } finally {
        client.release();
      }
      expect(await getFederatedConnectorGuardStatus(getPool(), LEASES)).toBe(
        "disabled",
      );
    } finally {
      await q(`ALTER TABLE ${LEASES} ENABLE ALWAYS TRIGGER ${trigger}`);
    }
  });

  it("detects a trigger that fires only in origin mode as outdated", async () => {
    const trigger = guardTrigger(AUDIT);
    await q(`ALTER TABLE ${AUDIT} ENABLE TRIGGER ${trigger}`);
    expect(await federatedConnectorGuardsNeedSync(getPool(), TABLES)).toBe(
      true,
    );
    const client = await getPool().connect();
    try {
      await ensureFederatedConnectorGuards(client, TABLES);
    } finally {
      client.release();
    }
    expect(await getFederatedConnectorGuardStatus(getPool(), AUDIT)).toBe("ok");
  });

  it("detects a missing trigger", async () => {
    const trigger = guardTrigger(APPROVALS);
    await q(`DROP TRIGGER ${trigger} ON ${APPROVALS}`);
    expect(await getFederatedConnectorGuardStatus(getPool(), APPROVALS)).toBe(
      "missing",
    );
    const client = await getPool().connect();
    try {
      await ensureFederatedConnectorGuards(client, TABLES);
    } finally {
      client.release();
    }
    expect(await getFederatedConnectorGuardStatus(getPool(), APPROVALS)).toBe(
      "ok",
    );
  });
});

describe("assignment audit", () => {
  it("sets time from the database clock, ignoring a supplied one", async () => {
    const id = await insertAudit();
    const { rows } = await q(
      `SELECT time > NOW() - INTERVAL '1 minute' AS fresh FROM ${AUDIT} WHERE id=$1`,
      [id],
    );
    expect(rows[0].fresh).toBe(true);
  });

  it("refuses update, delete of a recent row, and truncate", async () => {
    const id = await insertAudit();
    await expect(
      q(`UPDATE ${AUDIT} SET action='remove' WHERE id=$1`, [id]),
    ).rejects.toThrow(/append-only/);
    await expect(q(`DELETE FROM ${AUDIT} WHERE id=$1`, [id])).rejects.toThrow(
      /append-only/,
    );
    await expect(q(`TRUNCATE ${AUDIT}`)).rejects.toThrow(/append-only/);
  });

  it("allows no actor only for the system's own approval revocations", async () => {
    await expect(
      q(`INSERT INTO ${AUDIT} (id, action) VALUES ($1, 'assign')`, [uuid()]),
    ).rejects.toThrow();
    await expect(
      q(
        `INSERT INTO ${AUDIT} (id, action, after) VALUES ($1, 'shared-revoke', '{"reason":"owner"}')`,
        [uuid()],
      ),
    ).rejects.toThrow();
    for (const reason of ["rehome", "approver-demoted"]) {
      await q(
        `INSERT INTO ${AUDIT} (id, action, after) VALUES ($1, 'shared-revoke', $2)`,
        [uuid(), { reason }],
      );
    }
  });

  it("refuses an unknown action", async () => {
    await expect(
      q(
        `INSERT INTO ${AUDIT} (id, action, actor_account_id) VALUES ($1, 'other', $2)`,
        [uuid(), uuid()],
      ),
    ).rejects.toThrow();
  });
});

describe("turn leases", () => {
  it("inserts open with the database clock, ignoring supplied end fields", async () => {
    const id = await insertLease({
      created_at: new Date(0),
      ended_at: new Date(0),
      end_reason: "deny",
    });
    const row = await lease(id);
    expect(row.ended_at).toBeNull();
    expect(row.end_reason).toBeNull();
    expect(Date.now() - row.created_at.getTime()).toBeLessThan(60_000);
  });

  it("is unique per turn regardless of state", async () => {
    const turn = {
      account_id: uuid(),
      agent_id: uuid(),
      source_project_id: uuid(),
      run_id: uuid(),
      turn_key: "b".repeat(64),
    };
    const id = await insertLease(turn);
    await q(
      `UPDATE ${LEASES} SET ended_at=NOW(), end_reason='deny' WHERE lease_id=$1`,
      [id],
    );
    await expect(insertLease(turn)).rejects.toThrow(/duplicate key/);
  });

  it("ends exactly once, with ended_at from the database clock", async () => {
    const id = await insertLease();
    await q(
      `UPDATE ${LEASES} SET ended_at='2000-01-01', end_reason='revision' WHERE lease_id=$1`,
      [id],
    );
    const row = await lease(id);
    expect(row.end_reason).toBe("revision");
    expect(Date.now() - row.ended_at.getTime()).toBeLessThan(60_000);
    await expect(
      q(`UPDATE ${LEASES} SET end_reason='deny' WHERE lease_id=$1`, [id]),
    ).rejects.toThrow(/ended lease is immutable/);
    await expect(
      q(`UPDATE ${LEASES} SET ended_at=NOW() WHERE lease_id=$1`, [id]),
    ).rejects.toThrow(/ended lease is immutable/);
  });

  it("refuses an invalid end reason", async () => {
    const id = await insertLease();
    await expect(
      q(
        `UPDATE ${LEASES} SET ended_at=NOW(), end_reason='other' WHERE lease_id=$1`,
        [id],
      ),
    ).rejects.toThrow();
    expect((await lease(id)).ended_at).toBeNull();
  });

  it.each([
    ["host_id", "gen_random_uuid()"],
    ["grant_id", "gen_random_uuid()"],
    ["grant_revision", "grant_revision + 1"],
    ["assignment_revision", "assignment_revision + 1"],
    ["approval_id", "gen_random_uuid()"],
    ["turn_key", "'c'"],
    ["created_at", "NOW() - INTERVAL '1 day'"],
  ])(
    "refuses a change of %s, also together with ending",
    async (col, value) => {
      const id = await insertLease();
      await expect(
        q(`UPDATE ${LEASES} SET ${col}=${value} WHERE lease_id=$1`, [id]),
      ).rejects.toThrow(/binding is immutable/);
      await expect(
        q(
          `UPDATE ${LEASES} SET ${col}=${value}, ended_at=NOW(), end_reason='deny' WHERE lease_id=$1`,
          [id],
        ),
      ).rejects.toThrow(/binding is immutable/);
      expect((await lease(id)).ended_at).toBeNull();
    },
  );

  it("refuses an update that doesn't end the lease", async () => {
    const id = await insertLease();
    await expect(
      q(`UPDATE ${LEASES} SET end_reason=NULL WHERE lease_id=$1`, [id]),
    ).rejects.toThrow(/only change is ending/);
  });

  it("deletes only leases that ended before the retention period", async () => {
    const open = await insertLease();
    const recent = await insertLease();
    const old = await insertLease();
    await q(
      `UPDATE ${LEASES} SET ended_at=NOW(), end_reason='expired' WHERE lease_id = ANY($1)`,
      [[recent, old]],
    );
    await unguarded(
      LEASES,
      `UPDATE ${LEASES} SET ended_at = NOW() - INTERVAL '14 months' WHERE lease_id=$1`,
      [old],
    );
    await expect(
      q(`DELETE FROM ${LEASES} WHERE lease_id=$1`, [open]),
    ).rejects.toThrow(/retention/);
    await expect(
      q(`DELETE FROM ${LEASES} WHERE lease_id=$1`, [recent]),
    ).rejects.toThrow(/retention/);
    await q(`DELETE FROM ${LEASES} WHERE lease_id=$1`, [old]);
    expect(await lease(old)).toBeUndefined();
    await expect(q(`TRUNCATE ${LEASES}`)).rejects.toThrow(/truncate/);
  });
});

describe("shared-project approvals", () => {
  async function approval(approval_id: string) {
    const { rows } = await q(
      `SELECT * FROM ${APPROVALS} WHERE approval_id=$1`,
      [approval_id],
    );
    return rows[0];
  }

  it("inserts active, ignoring supplied revocation fields", async () => {
    const approval_id = uuid();
    await q(
      `INSERT INTO ${APPROVALS}
         (approval_id, project_id, account_id, approver_account_id, revoked_at, revoked_by, revoke_reason)
       VALUES ($1, $2, $3, $4, NOW(), $4, 'owner')`,
      [approval_id, uuid(), uuid(), uuid()],
    );
    const row = await approval(approval_id);
    expect(row.revoked_at).toBeNull();
    expect(row.revoked_by).toBeNull();
    expect(row.revoke_reason).toBeNull();
  });

  it("allows one active approval per project and account", async () => {
    const project_id = uuid();
    const account_id = uuid();
    const insert = () =>
      q(
        `INSERT INTO ${APPROVALS} (approval_id, project_id, account_id, approver_account_id)
         VALUES ($1, $2, $3, $4)`,
        [uuid(), project_id, account_id, uuid()],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key/);
    await q(
      `UPDATE ${APPROVALS} SET revoked_at=NOW(), revoked_by=$3, revoke_reason='owner'
        WHERE project_id=$1 AND account_id=$2`,
      [project_id, account_id, uuid()],
    );
    await insert();
  });

  it("revokes exactly once, by an owner or for a rehome", async () => {
    const byOwner = await insertApproval();
    await q(
      `UPDATE ${APPROVALS} SET revoked_at='2000-01-01', revoked_by=$2, revoke_reason='owner' WHERE approval_id=$1`,
      [byOwner, uuid()],
    );
    const row = await approval(byOwner);
    expect(Date.now() - row.revoked_at.getTime()).toBeLessThan(60_000);
    await expect(
      q(
        `UPDATE ${APPROVALS} SET revoke_reason='rehome', revoked_by=NULL WHERE approval_id=$1`,
        [byOwner],
      ),
    ).rejects.toThrow(/revoked approval is immutable/);

    const byRehome = await insertApproval();
    await q(
      `UPDATE ${APPROVALS} SET revoked_at=NOW(), revoke_reason='rehome' WHERE approval_id=$1`,
      [byRehome],
    );
    expect((await approval(byRehome)).revoke_reason).toBe("rehome");
  });

  it("refuses an owner revocation without an actor, and a rehome one with an actor", async () => {
    const id = await insertApproval();
    await expect(
      q(
        `UPDATE ${APPROVALS} SET revoked_at=NOW(), revoke_reason='owner' WHERE approval_id=$1`,
        [id],
      ),
    ).rejects.toThrow();
    await expect(
      q(
        `UPDATE ${APPROVALS} SET revoked_at=NOW(), revoked_by=$2, revoke_reason='rehome' WHERE approval_id=$1`,
        [id, uuid()],
      ),
    ).rejects.toThrow();
    expect((await approval(id)).revoked_at).toBeNull();
  });

  it("allows exactly the four revocation reasons", async () => {
    for (const [reason, by] of [
      ["self", uuid()],
      ["approver-demoted", null],
    ] as const) {
      const id = await insertApproval();
      await q(
        `UPDATE ${APPROVALS} SET revoked_at=NOW(), revoked_by=$2, revoke_reason=$3 WHERE approval_id=$1`,
        [id, by, reason],
      );
      expect((await approval(id)).revoke_reason).toBe(reason);
    }
    const id = await insertApproval();
    await expect(
      q(
        `UPDATE ${APPROVALS} SET revoked_at=NOW(), revoke_reason='other' WHERE approval_id=$1`,
        [id],
      ),
    ).rejects.toThrow();
  });

  it.each(["project_id", "account_id", "approver_account_id"])(
    "refuses a change of %s",
    async (col) => {
      const id = await insertApproval();
      await expect(
        q(
          `UPDATE ${APPROVALS} SET ${col}=gen_random_uuid() WHERE approval_id=$1`,
          [id],
        ),
      ).rejects.toThrow(/binding is immutable/);
    },
  );

  it("allows delete (project hard delete)", async () => {
    const id = await insertApproval();
    await q(`DELETE FROM ${APPROVALS} WHERE approval_id=$1`, [id]);
    expect(await approval(id)).toBeUndefined();
  });
});

describe("retention purge", () => {
  it("removes only rows past retention", async () => {
    const oldAudit = await insertAudit();
    await unguarded(
      AUDIT,
      `UPDATE ${AUDIT} SET time = NOW() - INTERVAL '14 months' WHERE id=$1`,
      [oldAudit],
    );
    const newAudit = await insertAudit();
    const oldApproval = await insertApproval();
    await q(
      `UPDATE ${APPROVALS} SET revoked_at=NOW(), revoke_reason='rehome' WHERE approval_id=$1`,
      [oldApproval],
    );
    await unguarded(
      APPROVALS,
      `UPDATE ${APPROVALS} SET revoked_at = NOW() - INTERVAL '14 months' WHERE approval_id=$1`,
      [oldApproval],
    );
    const active = await insertApproval();
    await unguarded(
      APPROVALS,
      `UPDATE ${APPROVALS} SET created_at = NOW() - INTERVAL '30 months' WHERE approval_id=$1`,
      [active],
    );
    const openLease = await insertLease();

    const result = await purgeExpiredFederatedConnectorRecords(getPool());
    expect(result.audit).toBeGreaterThanOrEqual(1);
    expect(result.approvals).toBe(1);

    const { rows: audits } = await q(
      `SELECT id FROM ${AUDIT} WHERE id = ANY($1)`,
      [[oldAudit, newAudit]],
    );
    expect(audits.map((r) => r.id)).toEqual([newAudit]);
    const { rows: approvals } = await q(
      `SELECT approval_id FROM ${APPROVALS} WHERE approval_id = ANY($1)`,
      [[oldApproval, active]],
    );
    expect(approvals.map((r) => r.approval_id)).toEqual([active]);
    expect(await lease(openLease)).toBeDefined();
  });
});
