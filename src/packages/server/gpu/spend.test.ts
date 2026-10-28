/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { ensureKeyBudget } from "./budgets";
import { getGpuSpend, getGpuSpendLocal, spendWindow } from "./spend";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const NOW = Date.parse("2026-10-28T12:00:00Z");
const HOUR = 3_600_000;
// the PGlite tests run as the owner's home bay
const deps = { now: () => NOW, isHomeBay: async () => true };

describe("spendWindow", () => {
  it("defaults to the last 30 days, and bounds the period", () => {
    expect(spendWindow({}, NOW)).toEqual({
      since: NOW - 30 * 24 * HOUR,
      until: NOW,
    });
    expect(() =>
      spendWindow(
        { since: "2026-10-28T12:00:00Z", until: "2026-10-01T00:00:00Z" },
        NOW,
      ),
    ).toThrow("since must be before until");
    expect(() => spendWindow({ since: "2024-01-01T00:00:00Z" }, NOW)).toThrow(
      "at most 400 days",
    );
    expect(() => spendWindow({ since: "yesterday" }, NOW)).toThrow("ISO time");
  });
});

describe("getGpuSpend on the signed-in bay", () => {
  it("forwards only the known fields to the owner's home bay, which validates them", async () => {
    const gpuSpend = jest.fn(async () => ({ rows: [] }) as any);
    const account_id = randomUUID();
    await getGpuSpend(
      {
        account_id,
        since: "2026-10-01T00:00:00Z",
        group_by: "agent",
        extra: "dropped",
      } as any,
      { homeClient: async () => ({ gpuSpend }) as any },
    );
    expect(gpuSpend).toHaveBeenCalledWith({
      account_id,
      since: "2026-10-01T00:00:00Z",
      until: undefined,
      group_by: "agent",
    });
  });

  it("requires a signed-in account", async () => {
    await expect(getGpuSpend({})).rejects.toThrow("must be signed in");
  });

  it("reads spend only on the key owner's home bay, never an empty answer elsewhere", async () => {
    await expect(
      getGpuSpendLocal(
        { account_id: randomUUID() },
        { now: () => NOW, isHomeBay: async () => false },
      ),
    ).rejects.toThrow("only on the key owner's home bay");
  });
});

describeDb("gpu.spend", () => {
  beforeAll(async () => {
    await syncSchema({
      gpu_key_fences: SCHEMA.gpu_key_fences,
      gpu_budget_layers: SCHEMA.gpu_budget_layers,
      gpu_budget_events: SCHEMA.gpu_budget_events,
      gpu_pods: SCHEMA.gpu_pods,
      gpu_pod_reservations: SCHEMA.gpu_pod_reservations,
    });
  });

  async function keyLayer(owner: string) {
    const credential_id = randomUUID();
    await ensureKeyBudget(getPool() as any, {
      credential_id,
      key_owner_account_id: owner,
    });
    const { rows } = await getPool().query(
      "SELECT id FROM gpu_budget_layers WHERE credential_id = $1 AND scope_kind = 'key'",
      [credential_id],
    );
    return { credential_id, layer_id: rows[0].id as string };
  }

  // a beneficiary layer under the key: a pod funded through it has a
  // reservation on both layers
  async function beneficiaryLayer(
    owner: string,
    key: { credential_id: string; layer_id: string },
    beneficiary: string,
  ) {
    const id = randomUUID();
    await getPool().query(
      `INSERT INTO gpu_budget_layers (id, credential_id, key_owner_account_id, scope_kind,
         parent_id, parent_scope_kind, beneficiary_account_id, authorized_usd,
         starts_at, ends_at, state, created, updated)
       VALUES ($1, $2, $3, 'beneficiary', $4, 'key', $5, 100,
         now() - interval '1 year', now() + interval '1 year', 'active', now(), now())`,
      [id, key.credential_id, owner, key.layer_id, beneficiary],
    );
    return id;
  }

  async function pod(
    owner: string,
    credential_id: string,
    {
      beneficiary = owner,
      agent_id = null,
      project_id = null,
      cost_per_hr = "1",
      running_since = null,
      state = "terminated",
    }: {
      beneficiary?: string;
      agent_id?: string | null;
      project_id?: string | null;
      cost_per_hr?: string | null;
      running_since?: Date | null;
      state?: string;
    } = {},
  ) {
    const id = randomUUID();
    const handle = `cc-${randomUUID()
      .replace(/[^a-f]/g, "")
      .padEnd(16, "a")
      .slice(0, 16)}`;
    await getPool().query(
      `INSERT INTO gpu_pods (id, handle, key_owner_account_id, credential_id, provider,
         beneficiary_account_id, agent_id, project_id, spec, gpu_type_id, gpu_count, cloud,
         cost_per_hr, running_since, state, desired_state, max_runtime_minutes, deadline,
         created, updated)
       VALUES ($1, $2, $3, $4, 'runpod', $5, $6, $7, '{}', 'NVIDIA RTX A4000', 1, 'SECURE',
         $8, $9, $10, 'running', 60, now() + interval '1 day', now(), now())`,
      [
        id,
        handle,
        owner,
        credential_id,
        beneficiary,
        agent_id,
        project_id,
        cost_per_hr,
        running_since,
        state,
      ],
    );
    return { id, handle };
  }

  async function reservation(
    pod_id: string,
    layer_id: string,
    {
      state = "settled",
      spent_usd = "0",
      reserved_usd = "0",
      hourly_usd = "1",
      settled_at = new Date(NOW - HOUR),
    }: {
      state?: string;
      spent_usd?: string;
      reserved_usd?: string;
      hourly_usd?: string;
      settled_at?: Date | null;
    } = {},
  ) {
    await getPool().query(
      `INSERT INTO gpu_pod_reservations (id, pod_id, layer_id, state, reserved_usd,
         hourly_usd, gpu_count, pod_slots, spent_usd, released_usd, overrun_usd,
         settled_at, created, updated)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 1, $7, 0, 0, $8, now(), now())`,
      [
        randomUUID(),
        pod_id,
        layer_id,
        state,
        reserved_usd,
        hourly_usd,
        state === "settled" ? spent_usd : null,
        state === "settled" ? settled_at : null,
      ],
    );
  }

  it("counts each pod once, from the key layer only", async () => {
    const owner = randomUUID();
    const student = randomUUID();
    const key = await keyLayer(owner);
    const layer = await beneficiaryLayer(owner, key, student);
    const p = await pod(owner, key.credential_id, { beneficiary: student });
    await reservation(p.id, key.layer_id, { spent_usd: "2.5" });
    // the same pod's row on the beneficiary layer must not be added again
    await reservation(p.id, layer, { spent_usd: "2.5" });
    const result = await getGpuSpendLocal({ account_id: owner }, deps);
    expect(result.rows).toEqual([
      expect.objectContaining({
        key: student,
        spent_usd: "2.5000000000",
        pods: 1,
        pods_live: 0,
      }),
    ]);
    expect(result.totals.spent_usd).toBe("2.5000000000");
    expect(result.billed_through).toBeUndefined();
  });

  it("estimates live pods from running_since, as settlement will, and shows holds apart", async () => {
    const owner = randomUUID();
    const key = await keyLayer(owner);
    // running for 2 hours at $1.50/h; provisioning before that isn't counted
    const live = await pod(owner, key.credential_id, {
      cost_per_hr: "1.5",
      running_since: new Date(NOW - 2 * HOUR),
      state: "running",
    });
    await reservation(live.id, key.layer_id, {
      state: "active",
      reserved_usd: "1.5",
    });
    // no price recorded yet: the reserved hourly rate, $0.50/h for 1 hour
    const unpriced = await pod(owner, key.credential_id, {
      cost_per_hr: null,
      running_since: new Date(NOW - HOUR),
      state: "running",
    });
    await reservation(unpriced.id, key.layer_id, {
      state: "active",
      hourly_usd: "0.5",
    });
    // still provisioning: nothing billed yet
    const starting = await pod(owner, key.credential_id, { state: "creating" });
    await reservation(starting.id, key.layer_id, { state: "active" });
    // quarantined: held, neither spent nor live
    const held = await pod(owner, key.credential_id, { state: "terminating" });
    await reservation(held.id, key.layer_id, {
      state: "quarantined",
      reserved_usd: "4",
    });
    const { rows, totals } = await getGpuSpendLocal(
      { account_id: owner },
      deps,
    );
    expect(totals).toEqual({
      spent_usd: "0.0000000000",
      live_estimate_usd: "3.5000000000",
      held_usd: "4.0000000000",
    });
    expect(rows).toEqual([
      expect.objectContaining({ key: owner, pods: 4, pods_live: 3 }),
    ]);
  });

  it("counts settled spend by when it settled, and live pods only for a period reaching now", async () => {
    const owner = randomUUID();
    const key = await keyLayer(owner);
    const recent = await pod(owner, key.credential_id);
    await reservation(recent.id, key.layer_id, {
      spent_usd: "1",
      settled_at: new Date(NOW - 2 * HOUR),
    });
    const old = await pod(owner, key.credential_id);
    await reservation(old.id, key.layer_id, {
      spent_usd: "7",
      settled_at: new Date(NOW - 40 * 24 * HOUR),
    });
    const live = await pod(owner, key.credential_id, {
      running_since: new Date(NOW - HOUR),
      state: "running",
    });
    await reservation(live.id, key.layer_id, { state: "active" });
    const lastDay = await getGpuSpendLocal(
      { account_id: owner, since: new Date(NOW - 24 * HOUR).toISOString() },
      deps,
    );
    expect(lastDay.totals).toEqual(
      expect.objectContaining({
        spent_usd: "1.0000000000",
        live_estimate_usd: "1.0000000000",
      }),
    );
    // a period that ended in the past: what settled then, no live estimates
    const past = await getGpuSpendLocal(
      {
        account_id: owner,
        since: new Date(NOW - 60 * 24 * HOUR).toISOString(),
        until: new Date(NOW - 30 * 24 * HOUR).toISOString(),
      },
      deps,
    );
    expect(past.totals).toEqual({
      spent_usd: "7.0000000000",
      live_estimate_usd: "0.0000000000",
      held_usd: "0.0000000000",
    });
  });

  it("covers every key the owner had, and nobody else's pods", async () => {
    const owner = randomUUID();
    const earlier = await keyLayer(owner);
    const current = await keyLayer(owner);
    const a = await pod(owner, earlier.credential_id);
    await reservation(a.id, earlier.layer_id, { spent_usd: "1" });
    const b = await pod(owner, current.credential_id);
    await reservation(b.id, current.layer_id, { spent_usd: "2" });
    const stranger = randomUUID();
    const theirs = await keyLayer(stranger);
    const c = await pod(stranger, theirs.credential_id);
    await reservation(c.id, theirs.layer_id, { spent_usd: "100" });
    const mine = await getGpuSpendLocal({ account_id: owner }, deps);
    expect(mine.totals.spent_usd).toBe("3.0000000000");
  });

  it("groups by agent, project or pod, with an empty key for none", async () => {
    const owner = randomUUID();
    const key = await keyLayer(owner);
    const project_id = randomUUID();
    const byAgent = await pod(owner, key.credential_id, {
      agent_id: "agent-1",
      project_id,
    });
    await reservation(byAgent.id, key.layer_id, { spent_usd: "3" });
    const byPerson = await pod(owner, key.credential_id);
    await reservation(byPerson.id, key.layer_id, { spent_usd: "1" });

    const agents = await getGpuSpendLocal(
      { account_id: owner, group_by: "agent" },
      deps,
    );
    expect(agents.rows.map((r) => [r.key, r.spent_usd])).toEqual([
      ["agent-1", "3.0000000000"],
      ["", "1.0000000000"],
    ]);
    const projects = await getGpuSpendLocal(
      { account_id: owner, group_by: "project" },
      deps,
    );
    expect(projects.rows.map((r) => r.key)).toEqual([project_id, ""]);
    const pods = await getGpuSpendLocal(
      { account_id: owner, group_by: "pod" },
      deps,
    );
    expect(pods.rows.map((r) => [r.key, r.label])).toEqual([
      [byAgent.id, byAgent.handle],
      [byPerson.id, byPerson.handle],
    ]);
    await expect(
      getGpuSpendLocal({ account_id: owner, group_by: "course" }, deps),
    ).rejects.toThrow("group_by must be one of");
  });

  it("counts live pods and holds only for a period that contains now", async () => {
    const owner = randomUUID();
    const key = await keyLayer(owner);
    const live = await pod(owner, key.credential_id, {
      running_since: new Date(NOW - HOUR),
      state: "running",
    });
    await reservation(live.id, key.layer_id, { state: "active" });
    const held = await pod(owner, key.credential_id, { state: "terminating" });
    await reservation(held.id, key.layer_id, {
      state: "quarantined",
      reserved_usd: "4",
    });
    const future = await getGpuSpendLocal(
      {
        account_id: owner,
        since: new Date(NOW + 24 * HOUR).toISOString(),
        until: new Date(NOW + 48 * HOUR).toISOString(),
      },
      deps,
    );
    expect(future.rows).toEqual([]);
    expect(future.totals).toEqual({
      spent_usd: "0.0000000000",
      live_estimate_usd: "0.0000000000",
      held_usd: "0.0000000000",
    });
  });

  it("never returns a chat session's fingerprint-derived agent id", async () => {
    const owner = randomUUID();
    const key = await keyLayer(owner);
    const FINGERPRINT = "f1n9erpr1nt0000000000000000000000";
    for (const agent_id of [
      `session:${FINGERPRINT}`,
      "session:another0000000000000000000000",
      "agent-1",
    ]) {
      const p = await pod(owner, key.credential_id, { agent_id });
      await reservation(p.id, key.layer_id, { spent_usd: "1" });
    }
    const result = await getGpuSpendLocal(
      { account_id: owner, group_by: "agent" },
      deps,
    );
    const json = JSON.stringify(result);
    expect(json).not.toContain("session:");
    expect(json).not.toContain(FINGERPRINT);
    expect(result.rows.map((r) => [r.key, r.spent_usd, r.pods])).toEqual([
      ["chat-session", "2.0000000000", 2],
      ["agent-1", "1.0000000000", 1],
    ]);
    // the other groupings never carry agent ids at all
    for (const group_by of ["beneficiary", "project", "pod"]) {
      const other = await getGpuSpendLocal(
        { account_id: owner, group_by },
        deps,
      );
      expect(JSON.stringify(other)).not.toContain("session:");
    }
  });
});
