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
  advanceBillingAuthorityActivation,
  beginBillingAuthorityCommandExecution,
  cancelQueuedBillingAuthorityCommand,
  claimNextBillingAuthorityCommand,
  finishBillingAuthorityCommand,
  getBillingAuthorityCommand,
  getBillingAuthorityHealth,
  markBillingAuthorityLeaseServing,
  pruneBillingAuthorityCommands,
  registerBillingAuthorityCommandAccount,
  recordBillingAuthorityProviderMutationStart,
  reconcileExpiredBillingAuthorityLease,
  releaseBillingAuthorityLease,
  requestBillingAuthorityDrain,
  resumeBillingAuthorityGlobally,
  setBillingAuthorityAccountFrozen,
  submitBillingAuthorityCommand,
} from "./store";
import {
  __test__ as serviceTest,
  handleBillingAuthorityTransportRequest,
} from "./service";

const describePostgres =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe.skip : describe;

const INSTANCE_A = "11111111-1111-4111-8111-111111111111";
const INSTANCE_B = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const ADMIN_ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";
const ADMIN_PACKAGE_HUB_METHOD =
  "purchases.adminCreateMembershipPackagePurchase";
const ACTIVATION_ACCOUNT_IDS = [
  "10000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
  "30000000-0000-4000-8000-000000000003",
];

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
  await getPool().query(
    "DELETE FROM admin_membership_package_intents WHERE account_id=$1 OR admin_account_id=$2",
    [ACCOUNT_ID, ADMIN_ACCOUNT_ID],
  );
  await getPool().query("DELETE FROM purchases WHERE invoice_id LIKE $1", [
    `admin-membership-package:${ADMIN_ACCOUNT_ID}:%`,
  ]);
  await getPool().query("DELETE FROM billing_authority_account_fences");
  await getPool().query("DELETE FROM billing_authority_lease");
  await getPool().query("DELETE FROM billing_authority_migrations");
  await getPool().query(
    "DELETE FROM accounts WHERE account_id=ANY($1::UUID[])",
    [[ACCOUNT_ID, ...ACTIVATION_ACCOUNT_IDS]],
  );
  await getPool().query(
    `INSERT INTO billing_authority_migrations
       (name, phase, processed_count, complete, started_at, updated_at,
        completed_at)
     VALUES ('account-security-fences-v1', 'complete', 0, TRUE,
             clock_timestamp(), clock_timestamp(), clock_timestamp())`,
  );
}

async function createRecoverableAmbiguousPackage(
  identity: { instance_id: string; generation: number },
  {
    idempotencyKey,
    errorMessage = "the first provider outcome was ambiguous",
  }: { idempotencyKey: string; errorMessage?: string },
): Promise<BillingAuthoritySubmitRequest> {
  const item = request({
    kind: "account-local",
    operation: "admin-create-membership-package-purchase",
    actor_account_id: ADMIN_ACCOUNT_ID,
    input: {
      admin_account_id: ADMIN_ACCOUNT_ID,
      user_account_id: ACCOUNT_ID,
      source: "card",
      idempotency_key: idempotencyKey,
    },
  });
  await submitBillingAuthorityCommand(item);
  await getPool().query(
    `INSERT INTO admin_membership_package_intents
       (invoice_id, account_id, admin_account_id, request_hash, snapshot)
     VALUES ($1, $2, $3, $4, '{}'::JSONB)`,
    [
      `admin-membership-package:${ADMIN_ACCOUNT_ID}:${idempotencyKey}`,
      ACCOUNT_ID,
      ADMIN_ACCOUNT_ID,
      "a".repeat(64),
    ],
  );
  await claimNextBillingAuthorityCommand(identity);
  await recordBillingAuthorityProviderMutationStart({
    ...identity,
    command_id: item.command_id,
  });
  await finishBillingAuthorityCommand({
    ...identity,
    command_id: item.command_id,
    status: "uncertain",
    error: { message: errorMessage, code: "first_provider_ambiguity" },
  });
  return item;
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

  it("canonicalizes Unicode object keys independently of insertion order", async () => {
    await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const command_id = randomUUID();
    const precomposed = "\u00e9";
    const decomposed = "e\u0301";
    const command = (metadata: Record<string, unknown>) =>
      ({
        kind: "http",
        operation: "admin-purchase",
        input: { account_id: ACCOUNT_ID, metadata },
      }) satisfies BillingAuthorityCommand;
    const first = request(command({ [precomposed]: 1, [decomposed]: 2 }), {
      command_id,
    });
    await submitBillingAuthorityCommand(first);

    await expect(
      submitBillingAuthorityCommand({
        ...first,
        command: command({ [decomposed]: 2, [precomposed]: 1 }),
      }),
    ).resolves.toMatchObject({ command_id, status: "queued", reused: true });
  });

  it("timestamps and bounds an initially expired submission", async () => {
    await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const item = request(
      { kind: "maintenance", task: "statements" },
      { expires_in_ms: -1_000 },
    );

    await expect(submitBillingAuthorityCommand(item)).resolves.toMatchObject({
      command_id: item.command_id,
      status: "expired",
      finished_at: expect.any(String),
      error: { code: 408, status: 408 },
    });
  });

  it("timestamps an attempt-zero command that expires before readmission", async () => {
    await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const item = request({ kind: "maintenance", task: "statements" });
    await submitBillingAuthorityCommand(item);
    await cancelQueuedBillingAuthorityCommand(item.command_id);

    await expect(
      submitBillingAuthorityCommand({
        ...item,
        expires_at: new Date(Date.now() - 1_000).toISOString(),
      }),
    ).resolves.toMatchObject({
      command_id: item.command_id,
      status: "expired",
      finished_at: expect.any(String),
      error: { code: 408, status: 408 },
    });
    const { rows } = await getPool().query(
      `SELECT attempt_count, finished_at IS NOT NULL AS finished
         FROM billing_authority_commands WHERE command_id=$1`,
      [item.command_id],
    );
    expect(rows).toEqual([{ attempt_count: 0, finished: true }]);
  });

  it("stores a bounded fallback error for defective terminal completion", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    const item = request({ kind: "maintenance", task: "statements" });
    await submitBillingAuthorityCommand(item);
    await claimNextBillingAuthorityCommand(identity);

    await finishBillingAuthorityCommand({
      ...identity,
      command_id: item.command_id,
      status: "failed",
    });
    await expect(
      getBillingAuthorityCommand(item.command_id),
    ).resolves.toMatchObject({
      status: "failed",
      finished_at: expect.any(String),
      error: {
        message: "billing authority command failed",
        code: "billing_authority_command_failed",
      },
    });
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

  it("requeues only a durable uncertain admin card package recovery", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    const idempotencyKey = "recover-card-package";
    const command = {
      kind: "account-local" as const,
      operation: "admin-create-membership-package-purchase" as const,
      actor_account_id: ADMIN_ACCOUNT_ID,
      input: {
        admin_account_id: ADMIN_ACCOUNT_ID,
        user_account_id: ACCOUNT_ID,
        source: "card",
        idempotency_key: idempotencyKey,
      },
    };
    const item = request(command);
    await submitBillingAuthorityCommand(item);
    await getPool().query(
      `INSERT INTO admin_membership_package_intents
         (invoice_id, account_id, admin_account_id, request_hash, snapshot)
       VALUES ($1, $2, $3, $4, '{}'::JSONB)`,
      [
        `admin-membership-package:${ADMIN_ACCOUNT_ID}:${idempotencyKey}`,
        ACCOUNT_ID,
        ADMIN_ACCOUNT_ID,
        "a".repeat(64),
      ],
    );
    await claimNextBillingAuthorityCommand(identity);
    await recordBillingAuthorityProviderMutationStart({
      ...identity,
      command_id: item.command_id,
    });
    await finishBillingAuthorityCommand({
      ...identity,
      command_id: item.command_id,
      status: "uncertain",
      error: { message: "complete the existing invoice and retry" },
    });

    const retry = {
      ...item,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    await expect(submitBillingAuthorityCommand(retry)).resolves.toMatchObject({
      command_id: item.command_id,
      status: "queued",
    });
    const recovered = await claimNextBillingAuthorityCommand(identity);
    expect(recovered).toMatchObject({
      record: { command_id: item.command_id, status: "running" },
      command,
    });
    const { rows } = await getPool().query(
      "SELECT attempt_count FROM billing_authority_commands WHERE command_id=$1",
      [item.command_id],
    );
    expect(rows).toEqual([{ attempt_count: 2 }]);

    await finishBillingAuthorityCommand({
      ...identity,
      command_id: item.command_id,
      status: "uncertain",
      error: { message: "recovery remains incomplete" },
    });
    await expect(submitBillingAuthorityCommand(retry)).resolves.toMatchObject({
      command_id: item.command_id,
      status: "queued",
    });
  });

  it("recovers the real Hub API package envelope with renewed fresh auth", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    const idempotencyKey = "recover-hub-card-package";
    const command = {
      kind: "hub-api" as const,
      call: {
        name: ADMIN_PACKAGE_HUB_METHOD,
        account_id: ADMIN_ACCOUNT_ID.toUpperCase(),
        auth_session_hash: "original-fresh-auth-session",
        args: [
          {
            account_id: ADMIN_ACCOUNT_ID.toUpperCase(),
            user_account_id: ACCOUNT_ID.toUpperCase(),
            product: {
              type: "membership-package",
              kind: "team",
              membership_class: "  standard  ",
              seat_count: 1,
              interval: "month",
              starts_at: "2026-10-01T00:00:00-07:00",
              expires_at: "2026-11-01T00:00:00-07:00",
            },
            price: "25.0100000000000000001",
            source: "card",
            reason: "  recover a real Hub API package request  ",
            pricing_note: "  approved by billing operations  ",
            idempotency_key: `  ${idempotencyKey}  `,
          },
        ],
      },
    } satisfies BillingAuthorityCommand;
    const item = request(command);
    await submitBillingAuthorityCommand(item);
    await getPool().query(
      `INSERT INTO admin_membership_package_intents
         (invoice_id, account_id, admin_account_id, request_hash, snapshot)
       VALUES ($1, $2, $3, $4, '{}'::JSONB)`,
      [
        `admin-membership-package:${ADMIN_ACCOUNT_ID}:${idempotencyKey}`,
        ACCOUNT_ID,
        ADMIN_ACCOUNT_ID,
        "d".repeat(64),
      ],
    );
    await claimNextBillingAuthorityCommand(identity);
    await recordBillingAuthorityProviderMutationStart({
      ...identity,
      command_id: item.command_id,
    });
    await finishBillingAuthorityCommand({
      ...identity,
      command_id: item.command_id,
      status: "uncertain",
      error: { message: "complete the existing invoice and retry" },
    });

    await expect(
      submitBillingAuthorityCommand({
        ...item,
        command: {
          ...command,
          call: {
            ...command.call,
            args: [
              {
                ...command.call.args[0],
                reason: "changed financial request",
              },
            ],
          },
        },
      }),
    ).rejects.toMatchObject({ code: 409, status: 409 });

    const refreshedCommand = {
      ...command,
      call: {
        ...command.call,
        account_id: ADMIN_ACCOUNT_ID,
        auth_session_hash: "replacement-fresh-auth-session",
        args: [
          {
            ...command.call.args[0],
            account_id: ADMIN_ACCOUNT_ID,
            user_account_id: ACCOUNT_ID,
            session_hash: "ignored-stale-input-session",
            product: {
              type: "membership-package",
              kind: "team",
              membership_class: "standard",
              seat_count: 1,
              interval: "month",
              starts_at: "2026-10-01T07:00:00.000Z",
              expires_at: new Date("2026-11-01T07:00:00.000Z"),
            },
            price: 25.01,
            reason: "recover a real Hub API package request",
            pricing_note: "approved by billing operations",
            idempotency_key: idempotencyKey,
          },
        ],
      },
    } satisfies BillingAuthorityCommand;
    await expect(
      submitBillingAuthorityCommand({
        ...item,
        command: refreshedCommand,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).resolves.toMatchObject({
      command_id: item.command_id,
      status: "queued",
    });
    const recovered = await claimNextBillingAuthorityCommand(identity);
    expect(recovered).toMatchObject({
      record: { command_id: item.command_id, status: "running" },
    });
    expect(recovered?.command).toEqual(
      JSON.parse(JSON.stringify(refreshedCommand)),
    );
  });

  it("requeues a side-effect-free Hub auth failure with renewed credentials", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    const command = {
      kind: "hub-api" as const,
      call: {
        name: ADMIN_PACKAGE_HUB_METHOD,
        account_id: ADMIN_ACCOUNT_ID,
        auth_session_hash: "expired-fresh-auth-session",
        args: [
          {
            account_id: ADMIN_ACCOUNT_ID,
            user_account_id: ACCOUNT_ID,
            product: {
              type: "membership-package",
              kind: "team",
              membership_class: "standard",
              seat_count: 1,
              interval: "month",
            },
            price: 25,
            source: "card",
            reason: "approved package after renewed authentication",
            idempotency_key: "pre-intent-hub-auth-recovery",
          },
        ],
      },
    } satisfies BillingAuthorityCommand;
    const item = request(command);
    await submitBillingAuthorityCommand(item);
    await claimNextBillingAuthorityCommand(identity);
    await finishBillingAuthorityCommand({
      ...identity,
      command_id: item.command_id,
      status: "failed",
      error: { message: "fresh authentication expired" },
    });

    await expect(
      submitBillingAuthorityCommand({
        ...item,
        command: {
          ...command,
          call: {
            ...command.call,
            args: [
              {
                ...command.call.args[0],
                reason: "a different financial operation",
              },
            ],
          },
        },
      }),
    ).rejects.toMatchObject({ code: 409, status: 409 });

    const refreshedCommand = {
      ...command,
      call: {
        ...command.call,
        auth_session_hash: "renewed-fresh-auth-session",
      },
    } satisfies BillingAuthorityCommand;
    await expect(
      submitBillingAuthorityCommand({
        ...item,
        command: refreshedCommand,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).resolves.toMatchObject({
      command_id: item.command_id,
      status: "queued",
    });
    await expect(
      claimNextBillingAuthorityCommand(identity),
    ).resolves.toMatchObject({ command: refreshedCommand });

    // Provider evidence without the workflow's durable intent is inconsistent
    // and must never be guessed safe for another execution.
    await recordBillingAuthorityProviderMutationStart({
      ...identity,
      command_id: item.command_id,
    });
    await finishBillingAuthorityCommand({
      ...identity,
      command_id: item.command_id,
      status: "failed",
      error: { message: "provider response has no durable package intent" },
    });
    await expect(
      submitBillingAuthorityCommand({
        ...item,
        command: refreshedCommand,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).resolves.toMatchObject({ status: "failed", reused: true });
  });

  it("does not ignore credential changes for other Hub API methods", async () => {
    await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const command = {
      kind: "hub-api",
      call: {
        name: "purchases.purchaseMembershipPackage",
        account_id: ACCOUNT_ID,
        auth_session_hash: "first-session",
        args: [{ package_id: randomUUID() }],
      },
    } satisfies BillingAuthorityCommand;
    const item = request(command);
    await submitBillingAuthorityCommand(item);

    await expect(
      submitBillingAuthorityCommand({
        ...item,
        command: {
          ...command,
          call: {
            ...command.call,
            auth_session_hash: "second-session",
          },
        },
      }),
    ).rejects.toMatchObject({ code: 409, status: 409 });
  });

  it("canonicalizes account-local package input without weakening trust flags", async () => {
    await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const command = {
      kind: "account-local" as const,
      operation: "admin-create-membership-package-purchase" as const,
      actor_account_id: ADMIN_ACCOUNT_ID.toUpperCase(),
      input: {
        admin_account_id: ADMIN_ACCOUNT_ID.toUpperCase(),
        user_account_id: ACCOUNT_ID.toUpperCase(),
        product: {
          type: "membership-package",
          kind: "team",
          membership_class: "standard",
          seat_count: 1,
          starts_at: "2026-10-01T00:00:00-07:00",
        },
        price: "25.001",
        source: "card",
        reason: "  account-local package  ",
        idempotency_key: "  account-local-key  ",
        pricing_note: "  approved  ",
        trusted_admin: true,
      },
    } satisfies BillingAuthorityCommand;
    const item = request(command);
    await submitBillingAuthorityCommand(item);
    const normalized = {
      ...command,
      actor_account_id: ADMIN_ACCOUNT_ID,
      input: {
        ...command.input,
        admin_account_id: ADMIN_ACCOUNT_ID,
        user_account_id: ACCOUNT_ID,
        product: {
          ...command.input.product,
          starts_at: "2026-10-01T07:00:00.000Z",
        },
        price: 25.01,
        reason: "account-local package",
        idempotency_key: "account-local-key",
        pricing_note: "approved",
      },
    } satisfies BillingAuthorityCommand;
    await expect(
      submitBillingAuthorityCommand({ ...item, command: normalized }),
    ).resolves.toMatchObject({
      command_id: item.command_id,
      status: "queued",
      reused: true,
    });
    await expect(
      submitBillingAuthorityCommand({
        ...item,
        command: {
          ...normalized,
          input: { ...normalized.input, trusted_admin: false },
        },
      }),
    ).rejects.toMatchObject({ code: 409, status: 409 });
  });

  it("keeps unrelated or stale uncertain commands terminal", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    const unrelated = request({ kind: "maintenance", task: "statements" });
    await submitBillingAuthorityCommand(unrelated);
    await claimNextBillingAuthorityCommand(identity);
    await finishBillingAuthorityCommand({
      ...identity,
      command_id: unrelated.command_id,
      status: "uncertain",
      error: { message: "unknown provider outcome" },
    });
    await expect(
      submitBillingAuthorityCommand({
        ...unrelated,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).resolves.toMatchObject({ status: "uncertain", reused: true });

    const idempotencyKey = "stale-card-package";
    const stale = request({
      kind: "account-local",
      operation: "admin-create-membership-package-purchase",
      actor_account_id: ADMIN_ACCOUNT_ID,
      input: {
        admin_account_id: ADMIN_ACCOUNT_ID,
        user_account_id: ACCOUNT_ID,
        source: "card",
        idempotency_key: idempotencyKey,
      },
    });
    await submitBillingAuthorityCommand(stale);
    await getPool().query(
      `INSERT INTO admin_membership_package_intents
         (invoice_id, account_id, admin_account_id, request_hash, snapshot)
       VALUES ($1, $2, $3, $4, '{}'::JSONB)`,
      [
        `admin-membership-package:${ADMIN_ACCOUNT_ID}:${idempotencyKey}`,
        ACCOUNT_ID,
        ADMIN_ACCOUNT_ID,
        "b".repeat(64),
      ],
    );
    await claimNextBillingAuthorityCommand(identity);
    await recordBillingAuthorityProviderMutationStart({
      ...identity,
      command_id: stale.command_id,
    });
    await finishBillingAuthorityCommand({
      ...identity,
      command_id: stale.command_id,
      status: "uncertain",
      error: { message: "old unknown provider outcome" },
    });
    await getPool().query(
      `UPDATE billing_authority_commands
          SET provider_uncertain_started_at=clock_timestamp() - INTERVAL '24 hours'
        WHERE command_id=$1`,
      [stale.command_id],
    );
    await expect(
      submitBillingAuthorityCommand({
        ...stale,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).resolves.toMatchObject({ status: "uncertain", reused: true });
  });

  it("starts a fresh provider window after a delayed pre-provider failure", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    const idempotencyKey = "pre-provider-card-recovery";
    const item = request({
      kind: "account-local",
      operation: "admin-create-membership-package-purchase",
      actor_account_id: ADMIN_ACCOUNT_ID,
      input: {
        admin_account_id: ADMIN_ACCOUNT_ID,
        user_account_id: ACCOUNT_ID,
        source: "card",
        idempotency_key: idempotencyKey,
      },
    });
    await submitBillingAuthorityCommand(item);
    await getPool().query(
      `INSERT INTO admin_membership_package_intents
         (invoice_id, account_id, admin_account_id, request_hash, snapshot)
       VALUES ($1, $2, $3, $4, '{}'::JSONB)`,
      [
        `admin-membership-package:${ADMIN_ACCOUNT_ID}:${idempotencyKey}`,
        ACCOUNT_ID,
        ADMIN_ACCOUNT_ID,
        "c".repeat(64),
      ],
    );
    await claimNextBillingAuthorityCommand(identity);
    await finishBillingAuthorityCommand({
      ...identity,
      command_id: item.command_id,
      status: "failed",
      error: { message: "Stripe was unavailable before the first mutation" },
    });
    await getPool().query(
      `UPDATE billing_authority_commands
          SET first_started_at=clock_timestamp() - INTERVAL '30 days'
        WHERE command_id=$1`,
      [item.command_id],
    );

    await expect(
      submitBillingAuthorityCommand({
        ...item,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).resolves.toMatchObject({
      command_id: item.command_id,
      status: "queued",
    });
    await expect(
      claimNextBillingAuthorityCommand(identity),
    ).resolves.toMatchObject({
      record: { command_id: item.command_id },
    });
    await recordBillingAuthorityProviderMutationStart({
      ...identity,
      command_id: item.command_id,
    });
    const { rows } = await getPool().query<{
      provider_age_seconds: number;
      uncertain_started_at: Date | null;
      first_age_seconds: number;
      attempt_count: number;
    }>(
      `SELECT EXTRACT(EPOCH FROM
                (clock_timestamp() - provider_attempt_started_at))::FLOAT8
                AS provider_age_seconds,
              provider_uncertain_started_at AS uncertain_started_at,
              EXTRACT(EPOCH FROM
                (clock_timestamp() - first_started_at))::FLOAT8
                AS first_age_seconds,
              attempt_count
         FROM billing_authority_commands WHERE command_id=$1`,
      [item.command_id],
    );
    expect(rows[0].provider_age_seconds).toBeLessThan(5);
    expect(rows[0].uncertain_started_at).toBeNull();
    expect(rows[0].first_age_seconds).toBeGreaterThan(29 * 24 * 60 * 60);
    expect(rows[0].attempt_count).toBe(2);
    await finishBillingAuthorityCommand({
      ...identity,
      command_id: item.command_id,
      status: "uncertain",
      error: { message: "the first provider attempt became ambiguous" },
    });
    const { rows: uncertainRows } = await getPool().query<{
      uncertain_age_seconds: number;
    }>(
      `SELECT EXTRACT(EPOCH FROM
                (clock_timestamp() - provider_uncertain_started_at))::FLOAT8
                AS uncertain_age_seconds
         FROM billing_authority_commands WHERE command_id=$1`,
      [item.command_id],
    );
    expect(uncertainRows[0].uncertain_age_seconds).toBeLessThan(5);
    await expect(
      submitBillingAuthorityCommand({
        ...item,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).resolves.toMatchObject({
      command_id: item.command_id,
      status: "queued",
    });
  });

  it("does not consume recovery time for a definitive provider failure", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    const idempotencyKey = "definitive-card-failure";
    const item = request({
      kind: "account-local",
      operation: "admin-create-membership-package-purchase",
      actor_account_id: ADMIN_ACCOUNT_ID,
      input: {
        admin_account_id: ADMIN_ACCOUNT_ID,
        user_account_id: ACCOUNT_ID,
        source: "card",
        idempotency_key: idempotencyKey,
      },
    });
    await submitBillingAuthorityCommand(item);
    await getPool().query(
      `INSERT INTO admin_membership_package_intents
         (invoice_id, account_id, admin_account_id, request_hash, snapshot)
       VALUES ($1, $2, $3, $4, '{}'::JSONB)`,
      [
        `admin-membership-package:${ADMIN_ACCOUNT_ID}:${idempotencyKey}`,
        ACCOUNT_ID,
        ADMIN_ACCOUNT_ID,
        "f".repeat(64),
      ],
    );
    await claimNextBillingAuthorityCommand(identity);
    await recordBillingAuthorityProviderMutationStart({
      ...identity,
      command_id: item.command_id,
    });
    await finishBillingAuthorityCommand({
      ...identity,
      command_id: item.command_id,
      status: "failed",
      error: { message: "the card was definitively declined" },
    });
    await getPool().query(
      `UPDATE billing_authority_commands
          SET provider_attempt_started_at=clock_timestamp() - INTERVAL '30 days'
        WHERE command_id=$1`,
      [item.command_id],
    );

    await expect(
      submitBillingAuthorityCommand({
        ...item,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).resolves.toMatchObject({
      command_id: item.command_id,
      status: "queued",
    });
    await expect(
      claimNextBillingAuthorityCommand(identity),
    ).resolves.toMatchObject({
      record: { command_id: item.command_id },
    });
    const { rows } = await getPool().query<{
      provider_attempt_started_at: Date | null;
      provider_uncertain_started_at: Date | null;
    }>(
      `SELECT provider_attempt_started_at, provider_uncertain_started_at
         FROM billing_authority_commands WHERE command_id=$1`,
      [item.command_id],
    );
    expect(rows).toEqual([
      {
        provider_attempt_started_at: null,
        provider_uncertain_started_at: null,
      },
    ]);
  });

  it("does not let a later failure erase an earlier provider ambiguity", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    const idempotencyKey = "preserve-card-ambiguity";
    const item = request({
      kind: "account-local",
      operation: "admin-create-membership-package-purchase",
      actor_account_id: ADMIN_ACCOUNT_ID,
      input: {
        admin_account_id: ADMIN_ACCOUNT_ID,
        user_account_id: ACCOUNT_ID,
        source: "card",
        idempotency_key: idempotencyKey,
      },
    });
    await submitBillingAuthorityCommand(item);
    await getPool().query(
      `INSERT INTO admin_membership_package_intents
         (invoice_id, account_id, admin_account_id, request_hash, snapshot)
       VALUES ($1, $2, $3, $4, '{}'::JSONB)`,
      [
        `admin-membership-package:${ADMIN_ACCOUNT_ID}:${idempotencyKey}`,
        ACCOUNT_ID,
        ADMIN_ACCOUNT_ID,
        "e".repeat(64),
      ],
    );
    await claimNextBillingAuthorityCommand(identity);
    await recordBillingAuthorityProviderMutationStart({
      ...identity,
      command_id: item.command_id,
    });
    await finishBillingAuthorityCommand({
      ...identity,
      command_id: item.command_id,
      status: "uncertain",
      error: { message: "the first provider outcome was ambiguous" },
    });
    await submitBillingAuthorityCommand({
      ...item,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    await claimNextBillingAuthorityCommand(identity);
    await finishBillingAuthorityCommand({
      ...identity,
      command_id: item.command_id,
      status: "failed",
      error: { message: "renewed authentication was rejected before replay" },
    });
    await expect(
      getBillingAuthorityCommand(item.command_id),
    ).resolves.toMatchObject({
      status: "uncertain",
      error: { message: "the first provider outcome was ambiguous" },
    });
    const authorityEnabled = process.env.COCALC_BILLING_AUTHORITY_ENABLED;
    process.env.COCALC_BILLING_AUTHORITY_ENABLED = "1";
    try {
      await expect(
        handleBillingAuthorityTransportRequest({
          action: "status",
          command_id: item.command_id,
        }),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          status: "uncertain",
          error: { message: "the first provider outcome was ambiguous" },
        },
      });
    } finally {
      if (authorityEnabled == null) {
        delete process.env.COCALC_BILLING_AUTHORITY_ENABLED;
      } else {
        process.env.COCALC_BILLING_AUTHORITY_ENABLED = authorityEnabled;
      }
    }
    await expect(
      submitBillingAuthorityCommand({
        ...item,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).resolves.toMatchObject({ status: "queued" });
    await claimNextBillingAuthorityCommand(identity);
    await recordBillingAuthorityProviderMutationStart({
      ...identity,
      command_id: item.command_id,
    });
    await finishBillingAuthorityCommand({
      ...identity,
      command_id: item.command_id,
      status: "failed",
      error: { message: "a later Stripe step was definitively rejected" },
    });
    await expect(
      getBillingAuthorityCommand(item.command_id),
    ).resolves.toMatchObject({
      status: "uncertain",
      error: { message: "the first provider outcome was ambiguous" },
    });
    await expect(
      submitBillingAuthorityCommand({
        ...item,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).resolves.toMatchObject({ status: "queued" });
    await expect(
      cancelQueuedBillingAuthorityCommand(item.command_id),
    ).resolves.toMatchObject({
      status: "uncertain",
      error: { message: "the first provider outcome was ambiguous" },
    });
    await getPool().query(
      `UPDATE billing_authority_commands
          SET provider_uncertain_started_at=clock_timestamp() - INTERVAL '24 hours'
        WHERE command_id=$1`,
      [item.command_id],
    );

    await expect(
      submitBillingAuthorityCommand({
        ...item,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).resolves.toMatchObject({
      status: "uncertain",
      reused: true,
      error: { message: "the first provider outcome was ambiguous" },
    });
  });

  it("retains the first provider ambiguity until successful reconciliation", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    const item = await createRecoverableAmbiguousPackage(identity, {
      idempotencyKey: "preserve-earliest-provider-evidence",
    });

    await submitBillingAuthorityCommand({
      ...item,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    await claimNextBillingAuthorityCommand(identity);
    await recordBillingAuthorityProviderMutationStart({
      ...identity,
      command_id: item.command_id,
    });
    await finishBillingAuthorityCommand({
      ...identity,
      command_id: item.command_id,
      status: "uncertain",
      error: {
        message: "a later provider step was also ambiguous",
        code: "second_provider_ambiguity",
      },
    });
    await expect(
      getBillingAuthorityCommand(item.command_id),
    ).resolves.toMatchObject({
      status: "uncertain",
      error: {
        message: "the first provider outcome was ambiguous",
        code: "first_provider_ambiguity",
      },
    });

    await submitBillingAuthorityCommand({
      ...item,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    await setBillingAuthorityAccountFrozen({
      account_id: ACCOUNT_ID,
      frozen: true,
      reason: "test incident response",
      cause: "incident-response",
    });
    await expect(
      getBillingAuthorityCommand(item.command_id),
    ).resolves.toMatchObject({
      status: "uncertain",
      error: { code: "first_provider_ambiguity" },
    });
    await setBillingAuthorityAccountFrozen({
      account_id: ACCOUNT_ID,
      frozen: false,
      reason: "test incident resolved",
      cause: "incident-response",
    });

    await submitBillingAuthorityCommand({
      ...item,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    await claimNextBillingAuthorityCommand(identity);
    await finishBillingAuthorityCommand({
      ...identity,
      command_id: item.command_id,
      result: { reconciled: true },
    });
    await expect(
      getBillingAuthorityCommand(item.command_id),
    ).resolves.toMatchObject({
      status: "succeeded",
      result: { reconciled: true },
    });
    expect(
      (await getBillingAuthorityCommand(item.command_id))?.error,
    ).toBeUndefined();
  });

  it("timestamps and retains an expired recovery ambiguity for health and pruning", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    const item = await createRecoverableAmbiguousPackage(identity, {
      idempotencyKey: "expired-provider-recovery",
    });

    await expect(
      submitBillingAuthorityCommand({
        ...item,
        expires_at: new Date(Date.now() - 1_000).toISOString(),
      }),
    ).resolves.toMatchObject({
      status: "uncertain",
      finished_at: expect.any(String),
      error: { code: "first_provider_ambiguity" },
    });
    await expect(getBillingAuthorityHealth()).resolves.toMatchObject({
      failed: 1,
    });

    await getPool().query(
      `UPDATE billing_authority_commands
          SET finished_at=clock_timestamp() - INTERVAL '49 hours'
        WHERE command_id=$1`,
      [item.command_id],
    );
    await expect(pruneBillingAuthorityCommands()).resolves.toBe(0);
    const { rows } = await getPool().query(
      `SELECT status, command, error, finished_at IS NOT NULL AS finished
         FROM billing_authority_commands WHERE command_id=$1`,
      [item.command_id],
    );
    expect(rows).toEqual([
      expect.objectContaining({
        status: "uncertain",
        command: { redacted: true },
        error: expect.objectContaining({ code: "first_provider_ambiguity" }),
        finished: true,
      }),
    ]);
  });

  it("preserves provider evidence when a successor takes the lease", async () => {
    const first = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 100,
    });
    const oldIdentity = {
      instance_id: INSTANCE_A,
      generation: first!.generation,
    };
    const item = await createRecoverableAmbiguousPackage(oldIdentity, {
      idempotencyKey: "provider-evidence-lease-takeover",
    });
    await submitBillingAuthorityCommand({
      ...item,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    await claimNextBillingAuthorityCommand(oldIdentity);
    await recordBillingAuthorityProviderMutationStart({
      ...oldIdentity,
      command_id: item.command_id,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    await acquireBillingAuthorityLease({
      instance_id: INSTANCE_B,
      lease_ms: 5_000,
    });
    await expect(
      getBillingAuthorityCommand(item.command_id),
    ).resolves.toMatchObject({
      status: "uncertain",
      error: { code: "first_provider_ambiguity" },
    });
  });

  it("preserves provider evidence when an expired drain is reconciled", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 100,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    const item = await createRecoverableAmbiguousPackage(identity, {
      idempotencyKey: "provider-evidence-expired-drain",
    });
    await submitBillingAuthorityCommand({
      ...item,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    await claimNextBillingAuthorityCommand(identity);
    await recordBillingAuthorityProviderMutationStart({
      ...identity,
      command_id: item.command_id,
    });
    await requestBillingAuthorityDrain();
    await new Promise((resolve) => setTimeout(resolve, 150));

    await expect(reconcileExpiredBillingAuthorityLease()).resolves.toBe(true);
    await expect(
      getBillingAuthorityCommand(item.command_id),
    ).resolves.toMatchObject({
      status: "uncertain",
      error: { code: "first_provider_ambiguity" },
    });
  });

  it("recovers a committed package after the provider replay window", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    const idempotencyKey = "committed-card-recovery";
    const invoiceId = `admin-membership-package:${ADMIN_ACCOUNT_ID}:${idempotencyKey}`;
    const item = request({
      kind: "account-local",
      operation: "admin-create-membership-package-purchase",
      actor_account_id: ADMIN_ACCOUNT_ID,
      input: {
        admin_account_id: ADMIN_ACCOUNT_ID,
        user_account_id: ACCOUNT_ID,
        source: "card",
        idempotency_key: idempotencyKey,
      },
    });
    await submitBillingAuthorityCommand(item);
    await claimNextBillingAuthorityCommand(identity);
    await recordBillingAuthorityProviderMutationStart({
      ...identity,
      command_id: item.command_id,
    });
    await finishBillingAuthorityCommand({
      ...identity,
      command_id: item.command_id,
      status: "uncertain",
      error: { message: "completion acknowledgement was lost" },
    });
    await getPool().query(
      `INSERT INTO purchases
         (service, time, account_id, cost, description, invoice_id,
          period_start, period_end)
       VALUES ('membership', clock_timestamp(), $1, 25, $2::JSONB, $3,
               clock_timestamp(), clock_timestamp() + INTERVAL '1 month')`,
      [
        ACCOUNT_ID,
        JSON.stringify({
          type: "membership-package",
          package_id: "55555555-5555-4555-8555-555555555555",
        }),
        invoiceId,
      ],
    );
    await getPool().query(
      `UPDATE billing_authority_commands
          SET provider_uncertain_started_at=clock_timestamp() - INTERVAL '30 days'
        WHERE command_id=$1`,
      [item.command_id],
    );

    await expect(
      submitBillingAuthorityCommand({
        ...item,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).resolves.toMatchObject({
      command_id: item.command_id,
      status: "queued",
    });
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
      await getPool().query("DELETE FROM billing_authority_migrations");

      let progress;
      do {
        progress = await advanceBillingAuthorityActivation({ batch_size: 1 });
      } while (!progress.complete);

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

  it("refuses to expose a lease before durable activation completes", async () => {
    await getPool().query("DELETE FROM billing_authority_migrations");
    await expect(
      acquireBillingAuthorityLease({
        instance_id: INSTANCE_A,
        lease_ms: 5_000,
      }),
    ).rejects.toMatchObject({ code: 503, status: 503 });
    const { rows } = await getPool().query(
      "SELECT holder_id FROM billing_authority_lease WHERE name='primary'",
    );
    expect(rows[0]?.holder_id).toBeFalsy();
  });

  it("verifies restricted accounts added behind a durable scan cursor", async () => {
    const [behindCursor, first, second] = ACTIVATION_ACCOUNT_IDS;
    await getPool().query(
      `INSERT INTO accounts (account_id, created, banned, deleted)
       VALUES ($1, clock_timestamp(), TRUE, FALSE),
              ($2, clock_timestamp(), TRUE, FALSE)`,
      [first, second],
    );
    await getPool().query("DELETE FROM billing_authority_migrations");

    await expect(
      advanceBillingAuthorityActivation({ batch_size: 1 }),
    ).resolves.toMatchObject({ phase: "scan", complete: false });
    await getPool().query(
      `INSERT INTO accounts (account_id, created, banned, deleted)
       VALUES ($1, clock_timestamp(), TRUE, FALSE)`,
      [behindCursor],
    );

    let progress;
    do {
      progress = await advanceBillingAuthorityActivation({ batch_size: 1 });
    } while (!progress.complete);

    const { rows } = await getPool().query<{ account_id: string }>(
      `SELECT account_id::TEXT
         FROM billing_authority_account_fences
        WHERE account_id=ANY($1::UUID[]) AND frozen
        ORDER BY account_id`,
      [ACTIVATION_ACCOUNT_IDS],
    );
    expect(rows.map(({ account_id }) => account_id)).toEqual(
      ACTIVATION_ACCOUNT_IDS,
    );
    await expect(
      acquireBillingAuthorityLease({
        instance_id: INSTANCE_A,
        lease_ms: 5_000,
      }),
    ).resolves.toMatchObject({ generation: 1 });
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

  it("orders command claims after an in-flight account freeze", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    const queued = request({
      kind: "http",
      operation: "create-setup-intent",
      input: { account_id: ACCOUNT_ID },
    });
    await submitBillingAuthorityCommand(queued);

    const freezing = await getPool().connect();
    let claimSettled = false;
    try {
      await freezing.query("BEGIN");
      await freezing.query("SELECT pg_advisory_xact_lock($1)", [1_111_575_378]);
      const claim = claimNextBillingAuthorityCommand(identity).finally(() => {
        claimSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(claimSettled).toBe(false);

      await freezing.query(
        `INSERT INTO billing_authority_account_fences
           (account_id, frozen, reason, causes, generation, created_at, updated_at)
         VALUES ($1, TRUE, 'concurrent freeze',
                 '{"quarantine":{"reason":"concurrent freeze"}}'::JSONB,
                 1, clock_timestamp(), clock_timestamp())`,
        [ACCOUNT_ID],
      );
      await freezing.query(
        `UPDATE billing_authority_commands
            SET status='canceled', finished_at=clock_timestamp(),
                updated_at=clock_timestamp()
          WHERE command_id=$1 AND status='queued'`,
        [queued.command_id],
      );
      await freezing.query("COMMIT");

      await expect(claim).resolves.toBeUndefined();
      await expect(
        getBillingAuthorityCommand(queued.command_id),
      ).resolves.toMatchObject({ status: "canceled" });
    } finally {
      await freezing.query("ROLLBACK").catch(() => undefined);
      freezing.release();
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

  it("rejects dynamic account registration after lease expiry", async () => {
    const lease = await acquireBillingAuthorityLease({
      instance_id: INSTANCE_A,
      lease_ms: 5_000,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    const item = request({
      kind: "reconcile-legacy-credit",
      source: { kind: "payment-intent", payment_intent_id: "pi_expired" },
    });
    await submitBillingAuthorityCommand(item);
    await claimNextBillingAuthorityCommand(identity);
    await getPool().query(
      `UPDATE billing_authority_lease
          SET lease_until=clock_timestamp() - INTERVAL '1 second'
        WHERE name=$1`,
      ["primary"],
    );

    await expect(
      registerBillingAuthorityCommandAccount({
        ...identity,
        command_id: item.command_id,
        account_id: ACCOUNT_ID,
      }),
    ).rejects.toMatchObject({ status: 503 });
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
    const item = request({
      kind: "commercial-maintenance",
      task: "stripe-events",
    });
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
      lease_ms: 100,
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
    await recordBillingAuthorityProviderMutationStart({
      ...oldIdentity,
      command_id: item.command_id,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

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
    const { rows: providerRows } = await getPool().query<{
      boundary_preserved: boolean;
    }>(
      `SELECT provider_uncertain_started_at IS NOT NULL
                AND provider_uncertain_started_at=provider_attempt_started_at
                AS boundary_preserved
         FROM billing_authority_commands WHERE command_id=$1`,
      [item.command_id],
    );
    expect(providerRows).toEqual([{ boundary_preserved: true }]);
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
      lease_ms: 100,
    });
    const identity = { instance_id: INSTANCE_A, generation: lease!.generation };
    const item = request({ kind: "maintenance", task: "statements" });
    await submitBillingAuthorityCommand(item);
    await claimNextBillingAuthorityCommand(identity);
    await recordBillingAuthorityProviderMutationStart({
      ...identity,
      command_id: item.command_id,
    });
    await requestBillingAuthorityDrain();
    await new Promise((resolve) => setTimeout(resolve, 150));

    await expect(reconcileExpiredBillingAuthorityLease()).resolves.toBe(true);
    await expect(
      getBillingAuthorityCommand(item.command_id),
    ).resolves.toMatchObject({
      status: "uncertain",
      error: { code: "authority_lease_expired_during_drain" },
    });
    const { rows: providerRows } = await getPool().query<{
      boundary_preserved: boolean;
    }>(
      `SELECT provider_uncertain_started_at IS NOT NULL
                AND provider_uncertain_started_at=provider_attempt_started_at
                AS boundary_preserved
         FROM billing_authority_commands WHERE command_id=$1`,
      [item.command_id],
    );
    expect(providerRows).toEqual([{ boundary_preserved: true }]);
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
