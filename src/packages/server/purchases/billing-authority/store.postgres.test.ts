/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";

import type {
  BillingAuthorityCommand,
  BillingAuthoritySubmitRequest,
} from "./protocol";
import {
  acquireBillingAuthorityLease,
  cancelQueuedBillingAuthorityCommand,
  claimNextBillingAuthorityCommand,
  finishBillingAuthorityCommand,
  getBillingAuthorityCommand,
  getBillingAuthorityHealth,
  pruneBillingAuthorityCommands,
  reconcileExpiredBillingAuthorityLease,
  releaseBillingAuthorityLease,
  requestBillingAuthorityDrain,
  resumeBillingAuthorityGlobally,
  setBillingAuthorityAccountFrozen,
  submitBillingAuthorityCommand,
} from "./store";

const describePostgres =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe.skip : describe;

const INSTANCE_A = "11111111-1111-4111-8111-111111111111";
const INSTANCE_B = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";

function request(
  command: BillingAuthorityCommand,
  {
    command_id = randomUUID(),
    expires_in_ms = 60_000,
  }: { command_id?: string; expires_in_ms?: number } = {},
): BillingAuthoritySubmitRequest {
  return {
    command_id,
    command,
    expires_at: new Date(Date.now() + expires_in_ms).toISOString(),
  };
}

async function resetTables(): Promise<void> {
  await getPool().query("DELETE FROM billing_authority_commands");
  await getPool().query("DELETE FROM billing_authority_account_fences");
  await getPool().query("DELETE FROM billing_authority_lease");
}

describePostgres("billing authority PostgreSQL journal", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 30_000);

  beforeEach(resetTables);

  afterAll(async () => {
    await resetTables();
    await getPool().end();
  });

  it("deduplicates by command identity and rejects conflicting reuse", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    expect(lease).toEqual(expect.objectContaining({ generation: 1 }));
    const command_id = randomUUID();
    const first = request(
      { kind: "maintenance", task: "statements" },
      { command_id },
    );
    await expect(submitBillingAuthorityCommand(first)).resolves.toMatchObject({
      command_id,
      status: "queued",
    });
    await expect(submitBillingAuthorityCommand(first)).resolves.toMatchObject({
      command_id,
      status: "queued",
      reused: true,
    });
    await expect(
      submitBillingAuthorityCommand({
        ...first,
        command: { kind: "maintenance", task: "subscriptions" },
      }),
    ).rejects.toMatchObject({ code: 409, status: 409 });
  });

  it("coalesces identical retry commands onto one durable outcome", async () => {
    await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const first = request({
      kind: "http",
      operation: "create-payment-intent",
      input: { account_id: ACCOUNT_ID, amount: 10 },
    });
    const retry = { ...first, command_id: randomUUID() };
    first.deduplicate_for_ms = 60_000;
    retry.deduplicate_for_ms = 60_000;
    const inserted = await submitBillingAuthorityCommand(first);
    expect(inserted.command_id).toBe(first.command_id);
    expect(inserted.reused).toBeUndefined();
    await expect(submitBillingAuthorityCommand(retry)).resolves.toMatchObject({
      command_id: first.command_id,
      reused: true,
    });

    await cancelQueuedBillingAuthorityCommand(first.command_id);
    const resubmitted = await submitBillingAuthorityCommand(retry);
    expect(resubmitted).toMatchObject({
      command_id: retry.command_id,
      status: "queued",
    });
    expect(resubmitted.reused).toBeUndefined();
  });

  it("coalesces concurrent semantic retries into one row", async () => {
    await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const submissions = Array.from({ length: 4 }, () => ({
      ...request({
        kind: "http" as const,
        operation: "create-refund" as const,
        input: { account_id: ACCOUNT_ID, purchase_id: "purchase-1" },
      }),
      deduplicate_for_ms: 60_000,
    }));
    const records = await Promise.all(
      submissions.map(
        async (item) => await submitBillingAuthorityCommand(item),
      ),
    );
    expect(new Set(records.map(({ command_id }) => command_id)).size).toBe(1);
    const { rows } = await getPool().query(
      "SELECT COUNT(*)::INT AS count FROM billing_authority_commands",
    );
    expect(rows).toEqual([{ count: 1 }]);
  });

  it("claims critical, interactive, then maintenance lanes", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    const maintenance = request({ kind: "maintenance", task: "statements" });
    const interactive = request({
      kind: "http",
      operation: "get-customer",
      input: { account_id: ACCOUNT_ID },
    });
    const critical = request({
      kind: "account-stripe-cleanup",
      account_id: ACCOUNT_ID,
    });
    for (const item of [maintenance, interactive, critical]) {
      await submitBillingAuthorityCommand(item);
    }

    for (const expected of [critical, interactive, maintenance]) {
      const claimed = await claimNextBillingAuthorityCommand(identity);
      expect(claimed?.record.command_id).toBe(expected.command_id);
      await finishBillingAuthorityCommand({
        ...identity,
        command_id: expected.command_id,
        result: { ok: true },
      });
    }
    await expect(
      claimNextBillingAuthorityCommand(identity),
    ).resolves.toBeUndefined();
  });

  it("expires or cancels queued work before it can run", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    const expired = request(
      { kind: "maintenance", task: "statements" },
      { expires_in_ms: -1 },
    );
    const canceled = request({ kind: "maintenance", task: "subscriptions" });
    await expect(submitBillingAuthorityCommand(expired)).resolves.toMatchObject(
      {
        status: "expired",
      },
    );
    await submitBillingAuthorityCommand(canceled);
    await expect(
      cancelQueuedBillingAuthorityCommand(canceled.command_id),
    ).resolves.toMatchObject({ status: "canceled" });
    await expect(
      claimNextBillingAuthorityCommand(identity),
    ).resolves.toBeUndefined();
  });

  it("freezes an account, cancels queued work, and permits cleanup only", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const queued = request({
      kind: "http",
      operation: "create-setup-intent",
      input: { account_id: ACCOUNT_ID },
    });
    await submitBillingAuthorityCommand(queued);
    await setBillingAuthorityAccountFrozen({
      account_id: ACCOUNT_ID,
      frozen: true,
      reason: "test quarantine",
    });
    await expect(
      getBillingAuthorityCommand(queued.command_id),
    ).resolves.toMatchObject({
      status: "canceled",
    });
    await expect(
      submitBillingAuthorityCommand(
        request({
          kind: "http",
          operation: "create-setup-intent",
          input: { account_id: ACCOUNT_ID },
        }),
      ),
    ).rejects.toMatchObject({ code: 423, status: 423 });
    await expect(
      submitBillingAuthorityCommand(
        request({ kind: "account-stripe-cleanup", account_id: ACCOUNT_ID }),
      ),
    ).resolves.toMatchObject({ status: "queued", lane: "critical" });

    await setBillingAuthorityAccountFrozen({
      account_id: ACCOUNT_ID,
      frozen: false,
      reason: "test recovery",
    });
    await expect(
      submitBillingAuthorityCommand(
        request({
          kind: "http",
          operation: "create-setup-intent",
          input: { account_id: ACCOUNT_ID },
        }),
      ),
    ).resolves.toMatchObject({ status: "queued" });
    await releaseBillingAuthorityLease({
      instance_id: INSTANCE_A,
      generation: lease!.generation,
    });
  });

  it("serializes account fences with command admission", async () => {
    const blocker = await getPool().connect();
    let settled = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock($1)", [1_111_575_378]);
      const freezing = setBillingAuthorityAccountFrozen({
        account_id: ACCOUNT_ID,
        frozen: true,
        reason: "concurrent quarantine",
      }).then((value) => {
        settled = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      await blocker.query("COMMIT");
      await expect(freezing).resolves.toMatchObject({
        account_id: ACCOUNT_ID,
        frozen: true,
      });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("fences completion and marks an interrupted generation uncertain", async () => {
    const first = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 30,
    });
    const oldIdentity = {
      instance_id: INSTANCE_A,
      generation: first!.generation,
    };
    const item = request({ kind: "maintenance", task: "statements" });
    await submitBillingAuthorityCommand(item);
    await expect(
      claimNextBillingAuthorityCommand(oldIdentity),
    ).resolves.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 75));

    const second = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_B,
      lease_ms: 5_000,
    });
    expect(second!.generation).toBeGreaterThan(first!.generation);
    await expect(
      getBillingAuthorityCommand(item.command_id),
    ).resolves.toMatchObject({
      status: "uncertain",
      error: { code: "authority_generation_changed" },
    });
    await expect(
      finishBillingAuthorityCommand({
        ...oldIdentity,
        command_id: item.command_id,
        result: { stale: true },
      }),
    ).rejects.toMatchObject({ code: 503, status: 503 });
  });

  it("globally drains admission and resumes with a new generation", async () => {
    const first = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const queued = request({ kind: "maintenance", task: "statements" });
    await submitBillingAuthorityCommand(queued);
    await requestBillingAuthorityDrain();
    await expect(
      getBillingAuthorityCommand(queued.command_id),
    ).resolves.toMatchObject({ status: "canceled" });
    await expect(
      submitBillingAuthorityCommand(
        request({ kind: "maintenance", task: "statements" }),
      ),
    ).rejects.toMatchObject({ code: 503, status: 503 });
    await releaseBillingAuthorityLease({
      instance_id: INSTANCE_A,
      generation: first!.generation,
    });
    await expect(getBillingAuthorityHealth()).resolves.toMatchObject({
      ready: false,
      enabled: false,
      draining: true,
    });
    await resumeBillingAuthorityGlobally();
    const second = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_B,
      lease_ms: 5_000,
    });
    expect(second!.generation).toBeGreaterThan(first!.generation);
    await expect(getBillingAuthorityHealth()).resolves.toMatchObject({
      ready: true,
      enabled: true,
      draining: false,
      instance_id: INSTANCE_B,
    });
  });

  it("increments generation when the same instance reacquires an expired lease", async () => {
    const first = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 30,
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    const second = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    expect(second!.generation).toBeGreaterThan(first!.generation);
  });

  it("reconciles an authority that dies after global drain begins", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 30,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    const item = request({ kind: "maintenance", task: "statements" });
    await submitBillingAuthorityCommand(item);
    await claimNextBillingAuthorityCommand(identity);
    await requestBillingAuthorityDrain();
    await new Promise((resolve) => setTimeout(resolve, 75));

    await expect(reconcileExpiredBillingAuthorityLease()).resolves.toBe(true);
    await expect(
      getBillingAuthorityCommand(item.command_id),
    ).resolves.toMatchObject({
      status: "uncertain",
      error: { code: "authority_lease_expired_during_drain" },
    });
    await expect(getBillingAuthorityHealth()).resolves.toMatchObject({
      ready: false,
      enabled: false,
      draining: true,
    });
    expect((await getBillingAuthorityHealth()).instance_id).toBeUndefined();
    expect(
      (await getBillingAuthorityHealth()).active_command_id,
    ).toBeUndefined();
  });

  it("redacts sensitive payloads before deleting retained audit metadata", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const item = request({
      kind: "http",
      operation: "create-setup-intent",
      input: { account_id: ACCOUNT_ID },
    });
    await submitBillingAuthorityCommand(item);
    await claimNextBillingAuthorityCommand({
      instance_id: INSTANCE_A,
      generation: lease!.generation,
    });
    await finishBillingAuthorityCommand({
      instance_id: INSTANCE_A,
      generation: lease!.generation,
      command_id: item.command_id,
      result: { client_secret: "must-not-be-retained" },
    });
    await getPool().query(
      `UPDATE billing_authority_commands
          SET finished_at=clock_timestamp() - INTERVAL '49 hours'
        WHERE command_id=$1`,
      [item.command_id],
    );

    await expect(pruneBillingAuthorityCommands()).resolves.toBe(0);
    const { rows } = await getPool().query(
      `SELECT command, result
         FROM billing_authority_commands WHERE command_id=$1`,
      [item.command_id],
    );
    expect(rows[0]).toMatchObject({
      command: { redacted: true },
      result: null,
    });
    await getPool().query(
      `UPDATE billing_authority_commands
          SET finished_at=clock_timestamp() - INTERVAL '401 days'
        WHERE command_id=$1`,
      [item.command_id],
    );
    await expect(pruneBillingAuthorityCommands()).resolves.toBe(1);
    await expect(
      getBillingAuthorityCommand(item.command_id),
    ).resolves.toBeUndefined();
  });
});
