/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

import getPool, {
  getClient,
  initEphemeralDatabase,
} from "@cocalc/database/pool";

import type {
  BillingAuthorityCommand,
  BillingAuthoritySubmitRequest,
} from "./protocol";
import {
  BILLING_AUTHORITY_EXECUTION_LOCK,
  acquireBillingAuthorityLease,
  beginBillingAuthorityCommandExecution,
  cancelQueuedBillingAuthorityCommand,
  claimNextBillingAuthorityCommand,
  finishBillingAuthorityCommand,
  getBillingAuthorityCommand,
  getBillingAuthorityHealth,
  markBillingAuthorityLeaseServing,
  pruneBillingAuthorityCommands,
  registerBillingAuthorityCommandAccount,
  reconcileExpiredBillingAuthorityLease,
  releaseBillingAuthorityLease,
  requestBillingAuthorityDrain,
  resumeBillingAuthorityGlobally,
  setBillingAuthorityAccountFrozen,
  submitBillingAuthorityCommand,
} from "./store";
import { __test__ as serviceTest } from "./service";

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
  await getPool().query("DELETE FROM accounts WHERE account_id=$1", [
    ACCOUNT_ID,
  ]);
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

  it("does not semantically reuse terminal commands", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    const command = {
      kind: "http" as const,
      operation: "create-payment-intent" as const,
      input: { account_id: ACCOUNT_ID, amount: 10, purpose: "credit" },
    };
    const first = { ...request(command), deduplicate_for_ms: 60_000 };
    await submitBillingAuthorityCommand(first);
    await claimNextBillingAuthorityCommand(identity);
    await finishBillingAuthorityCommand({
      ...identity,
      command_id: first.command_id,
      result: { payment_intent: "pi_first" },
    });
    const second = await submitBillingAuthorityCommand({
      ...request(command),
      deduplicate_for_ms: 60_000,
    });
    expect(second).toMatchObject({ status: "queued" });
    expect(second.command_id).not.toBe(first.command_id);
  });

  it("checks drain state before returning an exact or semantic outcome", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    const item = {
      ...request({
        kind: "http" as const,
        operation: "create-setup-intent" as const,
        input: { account_id: ACCOUNT_ID },
      }),
      deduplicate_for_ms: 60_000,
    };
    await submitBillingAuthorityCommand(item);
    await claimNextBillingAuthorityCommand(identity);
    await finishBillingAuthorityCommand({
      ...identity,
      command_id: item.command_id,
      result: { client_secret: "secret" },
    });
    await requestBillingAuthorityDrain();
    await expect(submitBillingAuthorityCommand(item)).rejects.toMatchObject({
      code: 503,
      status: 503,
    });
  });

  it("requeues a stable command canceled before its first claim", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    const item = request(
      {
        kind: "stripe-webhook",
        event: { id: "evt_retry", type: "invoice.paid" },
      },
      { command_id: "55555555-5555-4555-8555-555555555555" },
    );
    await submitBillingAuthorityCommand(item);
    await cancelQueuedBillingAuthorityCommand(item.command_id);
    await getPool().query(
      `UPDATE billing_authority_commands
          SET finished_at=clock_timestamp() - INTERVAL '49 hours'
        WHERE command_id=$1`,
      [item.command_id],
    );
    await pruneBillingAuthorityCommands();
    await expect(getBillingAuthorityCommand(item.command_id)).resolves.toEqual(
      expect.objectContaining({ status: "canceled" }),
    );
    await expect(submitBillingAuthorityCommand(item)).resolves.toMatchObject({
      command_id: item.command_id,
      status: "queued",
    });
    await expect(claimNextBillingAuthorityCommand(identity)).resolves.toEqual(
      expect.objectContaining({ command: item.command }),
    );
  });

  it.each([
    ["banned", true, false, "ban"],
    ["deleted", false, true, "deletion"],
  ])(
    "backfills an account %s before exposing the first authority lease",
    async (_state, banned, deleted, cause) => {
      await getPool().query(
        `INSERT INTO accounts (account_id, created, banned, deleted)
         VALUES ($1, clock_timestamp(), $2, $3)`,
        [ACCOUNT_ID, banned, deleted],
      );

      await expect(
        acquireBillingAuthorityLease({
          instance_id: INSTANCE_A,
          lease_ms: 5_000,
        }),
      ).resolves.toMatchObject({ generation: 1 });
      const { rows } = await getPool().query(
        `SELECT frozen, causes
           FROM billing_authority_account_fences
          WHERE account_id=$1`,
        [ACCOUNT_ID],
      );
      expect(rows[0]).toMatchObject({
        frozen: true,
        causes: expect.objectContaining({ [cause]: expect.any(Object) }),
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
    },
  );

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
      cause: "quarantine",
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
      cause: "quarantine",
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

  it("cancels a cross-account command when its actor is frozen", async () => {
    const actor = "44444444-4444-4444-8444-444444444444";
    await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const item = request({
      kind: "http",
      operation: "create-payment-intent",
      actor_account_id: actor,
      input: {
        account_id: ACCOUNT_ID,
      },
    });
    await submitBillingAuthorityCommand(item);
    await setBillingAuthorityAccountFrozen({
      account_id: actor,
      frozen: true,
      cause: "incident-response",
      reason: "administrator compromised",
    });
    await expect(
      getBillingAuthorityCommand(item.command_id),
    ).resolves.toMatchObject({
      status: "canceled",
      account_ids: expect.arrayContaining([actor, ACCOUNT_ID]),
    });
  });

  it("keeps independent fence causes active", async () => {
    await setBillingAuthorityAccountFrozen({
      account_id: ACCOUNT_ID,
      frozen: true,
      cause: "deletion",
      reason: "account deletion",
    });
    await setBillingAuthorityAccountFrozen({
      account_id: ACCOUNT_ID,
      frozen: true,
      cause: "ban",
      reason: "account ban",
    });
    const result = await setBillingAuthorityAccountFrozen({
      account_id: ACCOUNT_ID,
      frozen: false,
      cause: "ban",
      reason: "account ban removed",
    });
    expect(result.frozen).toBe(true);
  });

  it("does not report a raw lease acquisition as a live authority", async () => {
    await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    await expect(getBillingAuthorityHealth()).resolves.toMatchObject({
      ready: false,
    });
    expect((await getBillingAuthorityHealth()).instance_id).toBeUndefined();
  });

  it("rejects a provider-resolved account that was frozen during execution", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    const item = request({
      kind: "reconcile-legacy-credit",
      source: { kind: "payment-intent", payment_intent_id: "pi_unknown" },
    });
    await submitBillingAuthorityCommand(item);
    await claimNextBillingAuthorityCommand(identity);
    await setBillingAuthorityAccountFrozen({
      account_id: ACCOUNT_ID,
      frozen: true,
      cause: "incident-response",
      reason: "provider account quarantined",
    });
    await expect(
      registerBillingAuthorityCommandAccount({
        ...identity,
        command_id: item.command_id,
        account_id: ACCOUNT_ID,
      }),
    ).rejects.toMatchObject({ status: 423 });
  });

  it("destroys a timed-out dedicated election query", async () => {
    await acquireBillingAuthorityLease({
      instance_id: INSTANCE_B,
      lease_ms: 5_000,
    });
    await getPool().query(
      `UPDATE billing_authority_lease
          SET lease_until=clock_timestamp() - INTERVAL '1 second'
        WHERE name=$1`,
      ["primary"],
    );
    const blocker = await getPool().connect();
    const dedicated = getClient();
    await dedicated.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock($1)", [
        BILLING_AUTHORITY_EXECUTION_LOCK,
      ]);
      await expect(
        serviceTest.boundedDedicatedQuery({
          client: dedicated,
          promise: acquireBillingAuthorityLease({
            instance_id: INSTANCE_A,
            lease_ms: 5_000,
            db: dedicated,
          }),
          timeoutMs: 50,
        }),
      ).rejects.toThrow("lease query timed out");
      await blocker.query("COMMIT");
      await new Promise((resolve) => setTimeout(resolve, 25));
      const { rows } = await getPool().query(
        "SELECT holder_id FROM billing_authority_lease WHERE name=$1",
        ["primary"],
      );
      expect(rows[0]?.holder_id).not.toBe(INSTANCE_A);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await dedicated.end().catch(() => undefined);
    }
  });

  it("holds generation fencing through an active financial transaction", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    await markBillingAuthorityLeaseServing(identity);
    const item = request({ kind: "commercial-maintenance" });
    await submitBillingAuthorityCommand(item);
    await claimNextBillingAuthorityCommand(identity);

    const execution = getClient();
    const successor = getClient();
    await execution.connect();
    await successor.connect();
    let successorSettled = false;
    try {
      await beginBillingAuthorityCommandExecution({
        identity,
        db: execution,
      });
      const { rows: expiredLease } = await getPool().query(
        `UPDATE billing_authority_lease
            SET lease_until=clock_timestamp() - INTERVAL '1 second'
          WHERE name=$1
          RETURNING holder_id, enabled,
                    lease_until <= clock_timestamp() AS expired`,
        ["primary"],
      );
      expect(expiredLease[0]).toMatchObject({
        holder_id: INSTANCE_A,
        enabled: true,
        expired: true,
      });
      const { rows: visibleLease } = await successor.query(
        `SELECT holder_id, enabled,
                lease_until <= clock_timestamp() AS expired
           FROM billing_authority_lease WHERE name=$1`,
        ["primary"],
      );
      expect(visibleLease[0]).toMatchObject({
        holder_id: INSTANCE_A,
        enabled: true,
        expired: true,
      });
      const acquireSuccessor = acquireBillingAuthorityLease({
        instance_id: INSTANCE_B,
        lease_ms: 5_000,
        db: successor,
      }).finally(() => {
        successorSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(successorSettled).toBe(false);

      await execution.query("ROLLBACK");
      await expect(acquireSuccessor).resolves.toMatchObject({
        generation: identity.generation + 1,
      });
      await expect(
        getBillingAuthorityCommand(item.command_id),
      ).resolves.toMatchObject({ status: "uncertain" });
    } finally {
      await execution.query("ROLLBACK").catch(() => undefined);
      await execution.end().catch(() => undefined);
      await successor.end().catch(() => undefined);
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
    await markBillingAuthorityLeaseServing({
      instance_id: INSTANCE_B,
      generation: second!.generation,
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
    await markBillingAuthorityLeaseServing({
      instance_id: INSTANCE_B,
      generation: second!.generation,
    });
    expect(second!.generation).toBeGreaterThan(first!.generation);
    await expect(getBillingAuthorityHealth()).resolves.toMatchObject({
      ready: true,
      enabled: true,
      draining: false,
      instance_id: INSTANCE_B,
    });
  });

  it("requires a different process for an explicit handoff", async () => {
    const first = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    await requestBillingAuthorityDrain({ exclude_holder_id: INSTANCE_A });
    await releaseBillingAuthorityLease({
      instance_id: INSTANCE_A,
      generation: first!.generation,
    });
    await resumeBillingAuthorityGlobally();

    await expect(
      acquireBillingAuthorityLease({
        instance_id: INSTANCE_A,
        lease_ms: 5_000,
      }),
    ).resolves.toBeUndefined();
    const second = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_B,
      lease_ms: 5_000,
    });
    expect(second!.generation).toBeGreaterThan(first!.generation);
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

  it("expires typed results before deleting retained audit metadata", async () => {
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
      `SELECT command, status, result, error
         FROM billing_authority_commands WHERE command_id=$1`,
      [item.command_id],
    );
    expect(rows[0]).toMatchObject({
      command: { redacted: true },
      status: "expired",
      result: null,
      error: {
        code: "billing_authority_result_expired",
        status: 410,
      },
    });
    await expect(submitBillingAuthorityCommand(item)).resolves.toMatchObject({
      status: "expired",
      reused: true,
      error: {
        code: "billing_authority_result_expired",
        status: 410,
      },
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

  it("does not rewrite an already-redacted webhook receipt", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    const item = request({
      kind: "stripe-webhook",
      event: { id: "evt_retention", type: "invoice.paid" },
    });
    await submitBillingAuthorityCommand(item);
    await claimNextBillingAuthorityCommand(identity);
    await finishBillingAuthorityCommand({
      ...identity,
      command_id: item.command_id,
      result: { processed: true },
    });
    await getPool().query(
      `UPDATE billing_authority_commands
          SET finished_at=clock_timestamp() - INTERVAL '49 hours'
        WHERE command_id=$1`,
      [item.command_id],
    );

    await pruneBillingAuthorityCommands();
    const first = await getPool().query<{ xmin: string }>(
      `SELECT xmin::TEXT AS xmin
         FROM billing_authority_commands WHERE command_id=$1`,
      [item.command_id],
    );
    await pruneBillingAuthorityCommands();
    const second = await getPool().query<{ xmin: string }>(
      `SELECT xmin::TEXT AS xmin
         FROM billing_authority_commands WHERE command_id=$1`,
      [item.command_id],
    );

    expect(second.rows[0].xmin).toBe(first.rows[0].xmin);
  });
});
