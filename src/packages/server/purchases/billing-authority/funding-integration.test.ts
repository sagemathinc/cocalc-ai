/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import {
  startBillingAuthorityService,
  stopBillingAuthorityService,
  isBillingAuthorityCommand,
} from "./service";
import {
  executeBillingAuthorityCommand,
  getBillingAuthorityStatus,
} from "./client";
import { resetBillingAuthorityContextForTests } from "./context";
import {
  createCourseFundingApprovals,
  registerCourseFundingApprovalService,
  ensureCourseFundingApprovalSchema,
} from "@cocalc/server/compute/funding/approvals";
import { requireFundingApprovalSession } from "@cocalc/server/compute/funding/approval-auth";
import {
  applyMonthlyCollection,
  readMonthlyCollection,
} from "../monthly-collection";
import { normalizeMonthlyCollectionTerms } from "@cocalc/util/monthly-collection";
import type { MonthlyCollectionTerms } from "@cocalc/util/monthly-collection";
import { setBillingAuthorityAccountFrozen } from "./store";

// Only independent sign-in is replaced here. The queue, lease, account fences,
// approval intent and consent transaction use real PostgreSQL and dispatch.
jest.mock("@cocalc/server/compute/funding/approval-auth", () => ({
  requireFundingApprovalSession: jest.fn(),
}));
jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: jest.fn(async () => undefined),
}));
const dbDescribe =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe.skip : describe;
dbDescribe("funding through the running billing authority", () => {
  const old = process.env.COCALC_BILLING_AUTHORITY_ENABLED;
  let unregister: (() => void) | undefined;
  beforeAll(async () => {
    await before({ noConat: true });
    await ensureCourseFundingApprovalSchema();
    process.env.COCALC_BILLING_AUTHORITY_ENABLED = "1";
    startBillingAuthorityService();
    const deadline = Date.now() + 15000;
    while (!(await getBillingAuthorityStatus()).ready) {
      if (Date.now() > deadline) throw Error("authority not ready");
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 60000);
  afterEach(() => {
    unregister?.();
    unregister = undefined;
  });
  afterAll(async () => {
    await stopBillingAuthorityService();
    if (old == null) delete process.env.COCALC_BILLING_AUTHORITY_ENABLED;
    else process.env.COCALC_BILLING_AUTHORITY_ENABLED = old;
    resetBillingAuthorityContextForTests();
    await after();
  });

  async function fixture() {
    const payer = randomUUID();
    await getPool().query("INSERT INTO accounts(account_id) VALUES($1)", [
      payer,
    ]);
    const approvals = createCourseFundingApprovals({
      approval_origin: "http://127.0.0.2:19212",
      validateTerms: (v: unknown) =>
        normalizeMonthlyCollectionTerms(v as MonthlyCollectionTerms),
      resolveReview: async () => ({
        payer: {
          account_id: payer,
          name: "QA",
          email: "qa@example.test",
          home_bay_id: "bay-0",
        },
        recipients: [],
        storage_retention_hours: 72,
      }),
      apply: async ({ db, terms, intent_id }) =>
        applyMonthlyCollection(db, payer, terms, intent_id),
    });
    unregister = registerCourseFundingApprovalService(approvals as any);
    (requireFundingApprovalSession as jest.Mock)
      .mockReset()
      .mockResolvedValue(payer);
    const intent = await approvals.propose({
      payer_account_id: payer,
      operation_id: randomUUID(),
      terms: {
        kind: "monthlyCollection",
        enabled: false,
        expected_version: 0,
        terms_version: 1,
      },
    });
    const command = {
      kind: "account-local" as const,
      operation: "apply-funding-approval" as const,
      actor_account_id: payer,
      input: {
        payer_account_id: payer,
        intent_id: intent.intent_id,
        terms_hash: intent.terms_hash,
        approved_session_hash: "independent-test-session",
      },
    };
    return { payer, intent, command };
  }
  it("accepts only the explicit new maintenance operations", () => {
    for (const task of [
      "monthly-collections",
      "credit-transfers",
      "provider-refunds",
    ])
      expect(isBillingAuthorityCommand({ kind: "maintenance", task })).toBe(
        true,
      );
    expect(
      isBillingAuthorityCommand({
        kind: "account-local",
        operation: "approve-arbitrary-spend",
        input: {},
      }),
    ).toBe(false);
  });
  it("dispatches one independent approval and returns the same outcome on retry", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([
      executeBillingAuthorityCommand(f.command),
      executeBillingAuthorityCommand(f.command),
    ]);
    expect(a).toEqual(b);
    expect((await readMonthlyCollection(f.payer)).consent).toMatchObject({
      enabled: false,
      version: 1,
    });
    const { rows } = await getPool().query(
      "SELECT status,account_ids FROM billing_authority_commands WHERE actor_account_id=$1",
      [f.payer],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("succeeded");
    expect(requireFundingApprovalSession).toHaveBeenCalled();
  });
  it("revalidates the independent session inside the executor", async () => {
    const f = await fixture();
    (requireFundingApprovalSession as jest.Mock).mockRejectedValue(
      Error("Independent session expired"),
    );
    await expect(executeBillingAuthorityCommand(f.command)).rejects.toThrow(
      "Independent session expired",
    );
    expect((await readMonthlyCollection(f.payer)).consent.version).toBe(0);
  });
  it("rejects a frozen payer before applying an approval", async () => {
    const f = await fixture();
    await setBillingAuthorityAccountFrozen({
      account_id: f.payer,
      frozen: true,
      reason: "test",
      cause: "operator",
    });
    await expect(executeBillingAuthorityCommand(f.command)).rejects.toThrow();
    expect((await readMonthlyCollection(f.payer)).consent.version).toBe(0);
  });
});
