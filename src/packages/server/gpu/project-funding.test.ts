/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The project funding approval state machine (PROJECT_FUNDING.md §4) against
// a real (PGlite) database. Both bays share it here: the funder's home (H,
// the layer) and the project's owning bay (P, the route) call each other
// through injected local calls, so their failures can be staged.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  approveProjectFundingLocal,
  changeProjectFundingLocal,
  deliverProjectFundingOutbox,
  projectFundingApprovalId,
  projectFundingEndedOnProjectLocal,
  reconcileProjectFunding,
  revokeProjectFundingLocal,
  type ProjectBayCalls,
  type ProjectFundingDeps,
} from "./project-funding";
import {
  markProjectRehomeImport,
  mergeProjectComputeApprovals,
  readProjectComputeApprovals,
} from "./project-funding-portable";
import {
  deliverProjectFundingMessageLocal,
  expireProjectFundingLeases,
  projectFundingStatusLocal,
  reserveProjectFundingSlotLocal,
  type ProjectFundingRouteDeps,
} from "./project-funding-routes";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const TERMS = {
  provider: "runpod",
  authorized_usd: "400",
  days: 7,
  agents_allowed: true,
};

// P's view of who the funder's home is: this bay
const routeDeps: ProjectFundingRouteDeps = {
  accountHomeBay: async () => getConfiguredBayId(),
};

function localProjectBay(over: Partial<ProjectBayCalls> = {}): ProjectBayCalls {
  return {
    reserve: (req) => reserveProjectFundingSlotLocal(req, routeDeps),
    deliver: (req) => deliverProjectFundingMessageLocal(req, routeDeps),
    status: (req) => projectFundingStatusLocal(req, routeDeps),
    ...over,
  };
}

interface World {
  funder: string;
  other: string;
  project_id: string;
  credential_id: string;
  deps: ProjectFundingDeps;
}

async function world(
  projectBay: ProjectBayCalls = localProjectBay(),
): Promise<World> {
  const funder = randomUUID();
  const other = randomUUID();
  const project_id = randomUUID();
  const credential_id = randomUUID();
  const other_credential = randomUUID();
  await getPool().query(
    `INSERT INTO projects (project_id, owning_bay_id, deleted, users) VALUES ($1, $2, false, $3)`,
    [
      project_id,
      getConfiguredBayId(),
      JSON.stringify({
        [funder]: { group: "owner" },
        [other]: { group: "collaborator" },
      }),
    ],
  );
  const credentials: Record<string, string> = {
    [funder]: credential_id,
    [other]: other_credential,
  };
  const deps: ProjectFundingDeps = {
    credentialId: async (a) => credentials[a],
    accountWriteFence: async () => {},
    projectBay: async () => projectBay,
    funderBay: async () => ({
      endedOnProject: (req) => projectFundingEndedOnProjectLocal(req, deps),
    }),
    assertSentByProjectBay: async () => {},
    funderName: async () => "Ada Lovelace",
    routeDeps,
  };
  return { funder, other, project_id, credential_id, deps };
}

async function approve(w: World, over: Record<string, unknown> = {}) {
  return await approveProjectFundingLocal(
    {
      account_id: w.funder,
      project_id: w.project_id,
      terms: TERMS,
      operation_id: randomUUID(),
      fresh_auth_verified: true,
      ...over,
    },
    w.deps,
  );
}

async function route(project_id: string) {
  const { rows } = await getPool().query(
    `SELECT * FROM project_compute_approvals WHERE project_id = $1 AND kind = 'approval' ORDER BY created`,
    [project_id],
  );
  return rows;
}

async function keyLayer(credential_id: string) {
  const { rows } = await getPool().query(
    `SELECT * FROM gpu_budget_layers WHERE credential_id = $1 AND scope_kind = 'key'`,
    [credential_id],
  );
  return rows[0];
}

async function projectLayer(approval_id: string) {
  const { rows } = await getPool().query(
    `SELECT * FROM gpu_budget_layers WHERE approval_id = $1`,
    [approval_id],
  );
  return rows[0];
}

async function undelivered(approval_id: string) {
  const { rows } = await getPool().query(
    `SELECT * FROM project_funding_outbox WHERE approval_id = $1 AND delivered_at IS NULL ORDER BY version`,
    [approval_id],
  );
  return rows;
}

async function makeDue(approval_id: string) {
  await getPool().query(
    `UPDATE project_funding_outbox SET next_attempt_at = now() - interval '1 second'
      WHERE approval_id = $1`,
    [approval_id],
  );
}

describeDb("project funding approvals across two bays", () => {
  beforeAll(async () => {
    await getPool().query(
      "CREATE TABLE IF NOT EXISTS projects (project_id UUID PRIMARY KEY, owning_bay_id TEXT, deleted BOOLEAN, users JSONB)",
    );
    await syncSchema({
      gpu_key_fences: SCHEMA.gpu_key_fences,
      gpu_budget_layers: SCHEMA.gpu_budget_layers,
      gpu_budget_events: SCHEMA.gpu_budget_events,
      gpu_pods: SCHEMA.gpu_pods,
      gpu_pod_reservations: SCHEMA.gpu_pod_reservations,
      project_compute_approvals: SCHEMA.project_compute_approvals,
      project_funding_outbox: SCHEMA.project_funding_outbox,
      project_rehome_imports: SCHEMA.project_rehome_imports,
    });
  });

  it("approves slot first: P's route and H's layer, activated and acknowledged", async () => {
    const w = await world();
    const view = await approve(w);
    expect(view).toMatchObject({
      project_id: w.project_id,
      state: "active",
      activated: true,
      agents_allowed: true,
    });
    expect(Number(view.authorized_usd)).toBe(400);
    const [r] = await route(w.project_id);
    expect(r).toMatchObject({
      state: "active",
      version: 2,
      layer_id: view.layer_id,
      funder_account_id: w.funder,
      lease_expires_at: null,
    });
    expect(r.display).toMatchObject({ funder_name: "Ada Lovelace" });
    const layer = await projectLayer(view.approval_id);
    expect(layer).toMatchObject({
      scope_kind: "project",
      parent_scope_kind: "key",
      project_id: w.project_id,
      state: "active",
    });
    expect(
      new Date(layer.ends_at).getTime() - new Date(layer.starts_at).getTime(),
    ).toBe(7 * 24 * 3600_000);
    expect(await undelivered(view.approval_id)).toEqual([]);
  });

  it("is idempotent per operation: a retry returns the same approval, nothing new", async () => {
    const w = await world();
    const operation_id = randomUUID();
    const a = await approve(w, { operation_id });
    const b = await approve(w, { operation_id });
    expect(b.approval_id).toBe(a.approval_id);
    expect(a.approval_id).toBe(
      projectFundingApprovalId(w.funder, operation_id),
    );
    expect(await route(w.project_id)).toHaveLength(1);
    // the same operation with other terms is refused
    await expect(
      approve(w, { operation_id, terms: { ...TERMS, authorized_usd: "500" } }),
    ).rejects.toThrow(/different terms|already/);
  });

  it("gives the project's one slot to one funder: a second collaborator is refused", async () => {
    const w = await world();
    await approve(w);
    await expect(
      approveProjectFundingLocal(
        {
          account_id: w.other,
          project_id: w.project_id,
          terms: TERMS,
          operation_id: randomUUID(),
          fresh_auth_verified: true,
        },
        w.deps,
      ),
    ).rejects.toThrow(/already funded/);
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM gpu_budget_layers WHERE project_id = $1`,
      [w.project_id],
    );
    expect(rows[0].n).toBe(1);
  });

  it("races two funders for one slot: exactly one approval exists", async () => {
    const w = await world();
    const results = await Promise.allSettled([
      approve(w),
      approveProjectFundingLocal(
        {
          account_id: w.other,
          project_id: w.project_id,
          terms: TERMS,
          operation_id: randomUUID(),
          fresh_auth_verified: true,
        },
        w.deps,
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (await route(w.project_id)).filter((r) => r.state !== "ended"),
    ).toHaveLength(1);
  });

  it("refuses a funder who isn't a collaborator, and approval without fresh auth", async () => {
    const w = await world();
    await getPool().query(
      `UPDATE projects SET users = users - $2 WHERE project_id = $1`,
      [w.project_id, w.funder],
    );
    await expect(approve(w)).rejects.toThrow(/collaborator/);
    await expect(approve(w, { fresh_auth_verified: false })).rejects.toThrow(
      /sign in again/,
    );
  });

  it("refuses a reserve that doesn't come from the funder's home bay", async () => {
    const w = await world();
    await expect(
      reserveProjectFundingSlotLocal(
        {
          source_bay_id: "some-other-bay",
          project_id: w.project_id,
          provider: "runpod",
          approval_id: randomUUID(),
          operation_id: randomUUID(),
          terms_hash: "0".repeat(64),
          funder_account_id: w.funder,
          display: { authorized_usd: "1", ends_at: "", agents_allowed: true },
        },
        routeDeps,
      ),
    ).rejects.toThrow(/home bay/);
  });

  it("revokes on H at once, ends P's route, and a delayed activate never resurrects it", async () => {
    const w = await world();
    const view = await approve(w);
    const revoked = await revokeProjectFundingLocal(
      { account_id: w.funder, approval_id: view.approval_id },
      w.deps,
    );
    expect(revoked.state).toBe("revoked");
    const layer = await projectLayer(view.approval_id);
    expect(layer.ended_at).not.toBeNull();
    expect(layer.admission_closed_at).not.toBeNull();
    const [r] = await route(w.project_id);
    expect(r).toMatchObject({ state: "ended", ended_reason: "revoked" });
    // the original activate arrives again, late
    const late = await deliverProjectFundingMessageLocal(
      {
        source_bay_id: getConfiguredBayId(),
        project_id: w.project_id,
        funder_account_id: w.funder,
        message: {
          kind: "activate",
          approval_id: view.approval_id,
          version: 2,
          layer_id: view.layer_id,
          display: r.display,
        },
      },
      routeDeps,
    );
    expect(late).toMatchObject({ status: "committed", outcome: "stale" });
    expect((await route(w.project_id))[0].state).toBe("ended");
    // and the project can be funded again
    await expect(approve(w)).resolves.toMatchObject({ state: "active" });
  });

  it("applies a change on H first: lowering needs no fresh auth, raising does", async () => {
    const w = await world();
    const view = await approve(w);
    const lowered = await changeProjectFundingLocal(
      {
        account_id: w.funder,
        approval_id: view.approval_id,
        change: { authorized_usd: "100", agents_allowed: false },
      },
      w.deps,
    );
    expect(Number(lowered.authorized_usd)).toBe(100);
    expect(lowered.agents_allowed).toBe(false);
    expect((await projectLayer(view.approval_id)).agents_allowed).toBe(false);
    const [r] = await route(w.project_id);
    expect(r.display).toMatchObject({ agents_allowed: false });
    expect(Number(r.display.authorized_usd)).toBe(100);
    for (const change of [
      { authorized_usd: "500" },
      { agents_allowed: true },
    ]) {
      await expect(
        changeProjectFundingLocal(
          { account_id: w.funder, approval_id: view.approval_id, change },
          w.deps,
        ),
      ).rejects.toThrow(/sign in again/);
    }
  });

  it("ends a slot whose activation never arrived, revokes the layer and undoes the key-budget raise", async () => {
    // P can't be reached for delivery: the layer is made but never activated
    const unreachable = localProjectBay({
      deliver: async () => {
        throw Error("P unreachable");
      },
    });
    const w = await world(unreachable);
    const before = await keyLayer(w.credential_id); // undefined: made on approve
    expect(before).toBeUndefined();
    const view = await approve(w, { raise_key_budget_to: "400" });
    expect(view.activated).toBe(false);
    expect(Number((await keyLayer(w.credential_id)).authorized_usd)).toBe(400);
    // the lease runs out on P
    await getPool().query(
      `UPDATE project_compute_approvals SET lease_expires_at = now() - interval '1 second'
        WHERE approval_id = $1`,
      [view.approval_id],
    );
    expect(await expireProjectFundingLeases(routeDeps)).toBeGreaterThanOrEqual(
      1,
    );
    expect((await route(w.project_id))[0]).toMatchObject({
      state: "ended",
      ended_reason: "lease_expired",
    });
    // P's message to H ('end', target funder) revokes the layer
    await makeDue(view.approval_id);
    await deliverProjectFundingOutbox(
      { approval_id: view.approval_id },
      w.deps,
    );
    const layer = await projectLayer(view.approval_id);
    expect(layer).toMatchObject({
      state: "revoked",
      revoked_reason: "activation_failed",
    });
    expect(Number((await keyLayer(w.credential_id)).authorized_usd)).toBe(20);
  });

  it("keeps the raise when the key budget changed since (full-snapshot compare)", async () => {
    const unreachable = localProjectBay({
      deliver: async () => {
        throw Error("P unreachable");
      },
    });
    const w = await world(unreachable);
    const view = await approve(w, { raise_key_budget_to: "400" });
    // an own-key launch reserved some of the new room meanwhile
    await getPool().query(
      `UPDATE gpu_budget_layers SET reserved_usd = reserved_usd + 30
        WHERE credential_id = $1 AND scope_kind = 'key'`,
      [w.credential_id],
    );
    await projectFundingEndedOnProjectLocal(
      {
        source_bay_id: getConfiguredBayId(),
        project_id: w.project_id,
        approval_id: view.approval_id,
        funder_account_id: w.funder,
        reason: "lease_expired",
        version: 3,
      },
      w.deps,
    );
    expect(Number((await keyLayer(w.credential_id)).authorized_usd)).toBe(400);
    const { rows } = await getPool().query(
      `SELECT after FROM gpu_budget_events WHERE layer_id = $1 ORDER BY at DESC LIMIT 1`,
      [(await keyLayer(w.credential_id)).id],
    );
    expect(rows[0].after.raise_kept_for_approval).toBe(view.approval_id);
  });

  it("answers 'rehoming' during a rehome import and delivers once it merged", async () => {
    const w = await world();
    const view = await approve(w);
    await getPool().query(
      `INSERT INTO project_rehome_imports (project_id, source_bay_id) VALUES ($1, 'old-bay')`,
      [w.project_id],
    );
    await changeProjectFundingLocal(
      {
        account_id: w.funder,
        approval_id: view.approval_id,
        change: { authorized_usd: "200" },
      },
      w.deps,
    );
    // the update waits: never applied, never read as 'ended'
    const [pending] = await undelivered(view.approval_id);
    expect(pending).toMatchObject({
      kind: "update",
      last_error: "project rehoming",
    });
    expect((await projectLayer(view.approval_id)).state).toBe("active");
    await getPool().query(
      "DELETE FROM project_rehome_imports WHERE project_id = $1",
      [w.project_id],
    );
    await makeDue(view.approval_id);
    await deliverProjectFundingOutbox(
      { approval_id: view.approval_id },
      w.deps,
    );
    expect(await undelivered(view.approval_id)).toEqual([]);
    expect(Number((await route(w.project_id))[0].display.authorized_usd)).toBe(
      200,
    );
  });

  it("answers 'rehoming' when this bay no longer owns the project", async () => {
    const w = await world();
    const view = await approve(w);
    await getPool().query(
      `UPDATE projects SET owning_bay_id = 'new-bay' WHERE project_id = $1`,
      [w.project_id],
    );
    const s = await projectFundingStatusLocal(
      {
        source_bay_id: getConfiguredBayId(),
        project_id: w.project_id,
        approval_id: view.approval_id,
        funder_account_id: w.funder,
      },
      routeDeps,
    );
    expect(s).toEqual({ status: "rehoming" });
  });

  it("reconciles: an unacknowledged activation P says ended is revoked; past its end, an approval expires", async () => {
    const unreachable = localProjectBay({
      deliver: async () => {
        throw Error("P unreachable");
      },
    });
    const w = await world(unreachable);
    const view = await approve(w);
    // P ended the slot (its lease ran out) but H never heard
    await getPool().query(
      `UPDATE project_compute_approvals SET state = 'ended', version = 2,
              ended_reason = 'lease_expired', ended_at = now(), lease_expires_at = NULL
        WHERE approval_id = $1`,
      [view.approval_id],
    );
    await getPool().query(
      `UPDATE gpu_budget_layers SET created = now() - interval '1 hour' WHERE approval_id = $1`,
      [view.approval_id],
    );
    const r1 = await reconcileProjectFunding(w.deps);
    expect(r1.ended).toBeGreaterThanOrEqual(1);
    expect((await projectLayer(view.approval_id)).revoked_reason).toBe(
      "activation_failed",
    );

    const w2 = await world();
    const v2 = await approve(w2);
    await getPool().query(
      `UPDATE gpu_budget_layers SET ends_at = now() - interval '1 second',
              starts_at = now() - interval '2 days' WHERE approval_id = $1`,
      [v2.approval_id],
    );
    await reconcileProjectFunding(w2.deps);
    expect(await projectLayer(v2.approval_id)).toMatchObject({
      state: "expired",
      revoked_reason: "expired",
    });
    await makeDue(v2.approval_id);
    await deliverProjectFundingOutbox({ approval_id: v2.approval_id }, w2.deps);
    expect((await route(w2.project_id))[0]).toMatchObject({
      state: "ended",
      ended_reason: "expired",
    });
  });

  it("acknowledges a lost activation answer when P reports the route active", async () => {
    let first = true;
    const lossy = localProjectBay({
      deliver: async (req) => {
        const result = await deliverProjectFundingMessageLocal(req, routeDeps);
        if (first) {
          first = false;
          throw Error("response lost");
        }
        return result;
      },
    });
    const w = await world(lossy);
    const view = await approve(w);
    expect(view.activated).toBe(false);
    expect((await route(w.project_id))[0].state).toBe("active");
    await getPool().query(
      `UPDATE gpu_budget_layers SET created = now() - interval '1 hour' WHERE approval_id = $1`,
      [view.approval_id],
    );
    const r = await reconcileProjectFunding(w.deps);
    expect(r.acked).toBeGreaterThanOrEqual(1);
    expect(
      (await projectLayer(view.approval_id)).activation_acked_at,
    ).not.toBeNull();
    // and the retried activate is a harmless ack
    await makeDue(view.approval_id);
    await deliverProjectFundingOutbox(
      { approval_id: view.approval_id },
      w.deps,
    );
    expect(await undelivered(view.approval_id)).toEqual([]);
  });

  it("refuses endedOnProject from a bay that doesn't own the project", async () => {
    const w = await world();
    const view = await approve(w);
    await expect(
      projectFundingEndedOnProjectLocal(
        {
          source_bay_id: "intruder",
          project_id: w.project_id,
          approval_id: view.approval_id,
          funder_account_id: w.funder,
          reason: "project_deleted",
          version: 9,
        },
        {
          ...w.deps,
          assertSentByProjectBay: async () => {
            throw Error("must come from its owning bay");
          },
        },
      ),
    ).rejects.toThrow(/owning bay/);
    expect((await projectLayer(view.approval_id)).state).toBe("active");
  });

  describe("project rehome cutover: every write waits, nothing reads as ended", () => {
    beforeAll(async () => {
      await getPool().query(
        `CREATE TABLE IF NOT EXISTS project_rehome_operations (
           op_id TEXT PRIMARY KEY, project_id UUID, status TEXT, stage TEXT,
           source_bay_id TEXT, dest_bay_id TEXT, created_at TIMESTAMPTZ DEFAULT now())`,
      );
    });

    // Every P call H can make, for one approval of the world's project.
    function calls(w: World, approval_id: string, layer_id: string) {
      const base = {
        source_bay_id: getConfiguredBayId(),
        project_id: w.project_id,
        funder_account_id: w.funder,
      };
      const display = {
        authorized_usd: "1",
        ends_at: "",
        agents_allowed: true,
      };
      return {
        reserve: () =>
          reserveProjectFundingSlotLocal(
            {
              ...base,
              provider: "runpod",
              approval_id: randomUUID(),
              operation_id: randomUUID(),
              terms_hash: "0".repeat(64),
              display,
            },
            routeDeps,
          ),
        activate: () =>
          deliverProjectFundingMessageLocal(
            {
              ...base,
              message: {
                kind: "activate",
                approval_id,
                version: 2,
                layer_id,
                display,
              },
            },
            routeDeps,
          ),
        update: () =>
          deliverProjectFundingMessageLocal(
            {
              ...base,
              message: { kind: "update", approval_id, version: 9, display },
            },
            routeDeps,
          ),
        end: () =>
          deliverProjectFundingMessageLocal(
            {
              ...base,
              message: {
                kind: "end",
                approval_id,
                version: 9,
                reason: "revoked",
                live_pods: 0,
                pods_version: 9,
              },
            },
            routeDeps,
          ),
        pods: () =>
          deliverProjectFundingMessageLocal(
            {
              ...base,
              message: {
                kind: "pods",
                approval_id,
                live_pods: 3,
                pods_version: 9,
              },
            },
            routeDeps,
          ),
        status: () =>
          projectFundingStatusLocal({ ...base, approval_id }, routeDeps),
      };
    }

    async function pendingSlot(w: World) {
      const approval_id = randomUUID();
      const r = await reserveProjectFundingSlotLocal(
        {
          source_bay_id: getConfiguredBayId(),
          project_id: w.project_id,
          provider: "runpod",
          approval_id,
          operation_id: randomUUID(),
          terms_hash: "1".repeat(64),
          funder_account_id: w.funder,
          display: { authorized_usd: "1", ends_at: "", agents_allowed: true },
        },
        routeDeps,
      );
      expect(r.status).toBe("reserved");
      return approval_id;
    }

    async function expectAllRehoming(w: World, approval_id: string) {
      const before = (await route(w.project_id))[0];
      for (const [name, call] of Object.entries(
        calls(w, approval_id, randomUUID()),
      )) {
        expect([name, await call()]).toEqual([name, { status: "rehoming" }]);
      }
      // the lease runs out meanwhile: the slot is not ended
      await getPool().query(
        `UPDATE project_compute_approvals SET lease_expires_at = now() - interval '1 second'
          WHERE approval_id = $1`,
        [approval_id],
      );
      await expireProjectFundingLeases(routeDeps);
      const after = (await route(w.project_id))[0];
      expect(after.state).toBe(before.state);
      expect(after.version).toBe(before.version);
    }

    it("on the source, while the rehome runs", async () => {
      const w = await world();
      const approval_id = await pendingSlot(w);
      await getPool().query(
        `INSERT INTO project_rehome_operations (op_id, project_id, status, stage, source_bay_id, dest_bay_id)
         VALUES ($1, $2, 'running', 'destination_accepted', 'here', 'there')`,
        [randomUUID(), w.project_id],
      );
      await expectAllRehoming(w, approval_id);
      // approve says to try again, it doesn't fail the approval
      await expect(approve(w)).rejects.toThrow(/moving between servers/);
      await getPool().query(
        `UPDATE project_rehome_operations SET status = 'failed' WHERE project_id = $1`,
        [w.project_id],
      );
    });

    it("on the destination, after the flip and before the merge commits; then the merge applies them", async () => {
      const w = await world();
      const approval_id = await pendingSlot(w);
      const copied = await readProjectComputeApprovals(w.project_id);
      // this bay is the destination: the first accept marked the import
      const db = await getPool().connect();
      try {
        await db.query("BEGIN");
        await markProjectRehomeImport(db, {
          project_id: w.project_id,
          source_bay_id: "old-bay",
        });
        await db.query("COMMIT");
      } finally {
        db.release();
      }
      await expectAllRehoming(w, approval_id);
      // the merge (portable state) ends the import and refreshes the lease
      await mergeProjectComputeApprovals({
        project_id: w.project_id,
        rows: copied,
      });
      const { rows: marker } = await getPool().query(
        "SELECT 1 FROM project_rehome_imports WHERE project_id = $1",
        [w.project_id],
      );
      expect(marker).toEqual([]);
      const [slot] = await route(w.project_id);
      expect(slot.state).toBe("pending");
      expect(new Date(slot.lease_expires_at).getTime()).toBeGreaterThan(
        Date.now() + 60_000,
      );
      const activated = await calls(w, approval_id, randomUUID()).activate();
      expect(activated).toMatchObject({
        status: "committed",
        outcome: "applied",
        state: "active",
      });
    });
  });
});
