import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { ensureLroSchema } from "./lro-db";
import { repairScheduledCollectionExpiryLocal } from "./scheduled-collection-expiry-repair";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("scheduled collection expiry repair transaction", () => {
  const actor_id = randomUUID();
  const project_id = randomUUID();
  let request;
  let original;

  beforeAll(async () => {
    process.env.COCALC_BAY_ID = "bay-0";
    await getPool().query(`CREATE TABLE IF NOT EXISTS projects (
      project_id uuid PRIMARY KEY, owning_bay_id text, deleted boolean
    )`);
    await ensureLroSchema();
    await getPool().query("INSERT INTO projects VALUES ($1, 'bay-0', false)", [
      project_id,
    ]);
  });

  beforeEach(async () => {
    const op_id = randomUUID();
    const updated_at = new Date().toISOString();
    const run_at = new Date(Date.now() + 20 * 86400000).toISOString();
    const expires_at = new Date(Date.now() + 7 * 86400000).toISOString();
    request = {
      actor_id,
      project_id,
      op_id,
      expected_updated_at: updated_at,
      expected_expires_at: expires_at,
      expected_run_at: run_at,
      reason: "synthetic scheduled expiry repair",
      idempotency_key: randomUUID(),
    };
    await getPool().query(
      `INSERT INTO long_running_operations
      (op_id, kind, scope_type, scope_id, status, routing, attempt,
       updated_at, expires_at, input, dedupe_key, result, progress_summary)
      VALUES ($1, 'course-collect-assignment', 'project', $2, 'queued', 'hub', 0,
              $3, $4, $5::jsonb, 'synthetic-dedupe', '{"preserve":true}', '{"preserve":true}')`,
      [
        op_id,
        project_id,
        updated_at,
        expires_at,
        JSON.stringify({ run_at, assignment_id: randomUUID(), items: [] }),
      ],
    );
    original = (
      await getPool().query(
        "SELECT * FROM long_running_operations WHERE op_id=$1",
        [op_id],
      )
    ).rows[0];
  });

  const row = async () =>
    (
      await getPool().query(
        "SELECT * FROM long_running_operations WHERE op_id=$1",
        [request.op_id],
      )
    ).rows[0];

  test("preview leaves the operation and durable receipts unchanged", async () => {
    const receipt = await repairScheduledCollectionExpiryLocal(request);
    expect(receipt.committed).toBe(false);
    expect(receipt.after.expires_at).toBe(
      new Date(
        Date.parse(request.expected_run_at) + 7 * 86400000,
      ).toISOString(),
    );
    expect(await row()).toEqual(original);
    expect(
      (
        await getPool().query(
          "SELECT * FROM scheduled_collection_expiry_repairs WHERE idempotency_key=$1",
          [request.idempotency_key],
        )
      ).rows,
    ).toEqual([]);
  });

  test("commit changes only expiry/updated_at and atomically records a replayable audit", async () => {
    const receipt = await repairScheduledCollectionExpiryLocal({
      ...request,
      commit: true,
    });
    const updated = await row();
    expect(updated.expires_at.toISOString()).toBe(receipt.after.expires_at);
    expect({
      ...updated,
      expires_at: original.expires_at,
      updated_at: original.updated_at,
    }).toEqual(original);
    const audit = (
      await getPool().query(
        "SELECT * FROM scheduled_collection_expiry_repairs WHERE idempotency_key=$1",
        [request.idempotency_key],
      )
    ).rows[0];
    expect(audit.actor_id).toBe(actor_id);
    expect(audit.reason).toBe(request.reason);
    expect(audit.receipt).toEqual(receipt);
    await expect(
      repairScheduledCollectionExpiryLocal({ ...request, commit: true }),
    ).resolves.toEqual({ ...receipt, replayed: true });
    expect(await row()).toEqual(updated);
    await expect(
      repairScheduledCollectionExpiryLocal({
        ...request,
        reason: "changed request",
        commit: true,
      }),
    ).rejects.toThrow("different request");
  });

  test.each(["expected_updated_at", "expected_expires_at", "expected_run_at"])(
    "rejects stale %s",
    async (field) => {
      await expect(
        repairScheduledCollectionExpiryLocal({
          ...request,
          [field]: "2020-01-01T00:00:00Z",
          commit: true,
        }),
      ).rejects.toThrow("changed since review");
      expect(await row()).toEqual(original);
    },
  );

  test.each([
    ["status", "running"],
    ["status", "canceled"],
    ["status", "expired"],
    ["attempt", 1],
    ["started_at", new Date()],
    ["finished_at", new Date()],
    ["dismissed_at", new Date()],
    ["kind", "project-start"],
    ["scope_type", "account"],
    ["scope_id", randomUUID()],
    ["routing", "project"],
  ])("rejects ineligible %s=%s", async (field, value) => {
    await getPool().query(
      `UPDATE long_running_operations SET ${field}=$2 WHERE op_id=$1`,
      [request.op_id, value],
    );
    const before = await row();
    await expect(
      repairScheduledCollectionExpiryLocal({ ...request, commit: true }),
    ).rejects.toThrow("only never-started");
    expect(await row()).toEqual(before);
  });

  test.each(["expired", "due", "immediate", "already-covered"])(
    "rejects %s without resurrecting/rescheduling",
    async (mode) => {
      const input = { ...original.input };
      let expiry = request.expected_expires_at;
      if (mode === "expired") expiry = "2020-01-01T00:00:00Z";
      if (mode === "due") input.run_at = "2020-01-01T00:00:00Z";
      if (mode === "immediate") delete input.run_at;
      if (mode === "already-covered")
        expiry = new Date(Date.parse(input.run_at) + 86400000).toISOString();
      await getPool().query(
        "UPDATE long_running_operations SET input=$2::jsonb, expires_at=$3 WHERE op_id=$1",
        [request.op_id, JSON.stringify(input), expiry],
      );
      const before = await row();
      await expect(
        repairScheduledCollectionExpiryLocal({
          ...request,
          expected_run_at: input.run_at ?? request.expected_run_at,
          expected_expires_at: expiry,
          commit: true,
        }),
      ).rejects.toThrow();
      expect(await row()).toEqual(before);
    },
  );

  test("authoritative project bay is rechecked inside the transaction", async () => {
    await getPool().query(
      "UPDATE projects SET owning_bay_id='bay-1' WHERE project_id=$1",
      [project_id],
    );
    try {
      await expect(
        repairScheduledCollectionExpiryLocal({ ...request, commit: true }),
      ).rejects.toThrow("not owned by this bay");
      expect(await row()).toEqual(original);
    } finally {
      await getPool().query(
        "UPDATE projects SET owning_bay_id='bay-0' WHERE project_id=$1",
        [project_id],
      );
    }
  });

  test("a sub-millisecond updated_at change is not hidden by Date serialization", async () => {
    await getPool().query(
      "UPDATE long_running_operations SET updated_at=updated_at+interval '1 microsecond' WHERE op_id=$1",
      [request.op_id],
    );
    await expect(
      repairScheduledCollectionExpiryLocal({ ...request, commit: true }),
    ).rejects.toThrow("changed since review");
  });

  test("failed audit insertion rolls back the expiry", async () => {
    const client = await getPool().connect();
    const connect = jest.spyOn(getPool(), "connect");
    const query = client.query.bind(client);
    connect.mockResolvedValue({
      ...client,
      release: () => client.release(),
      query: async (sql, params) => {
        if (
          `${sql}`.includes("INSERT INTO scheduled_collection_expiry_repairs")
        )
          throw new Error("synthetic audit unavailable");
        return await query(sql, params);
      },
    } as any);
    try {
      await expect(
        repairScheduledCollectionExpiryLocal({ ...request, commit: true }),
      ).rejects.toThrow("audit unavailable");
    } finally {
      connect.mockRestore();
    }
    expect(await row()).toEqual(original);
  });
});
