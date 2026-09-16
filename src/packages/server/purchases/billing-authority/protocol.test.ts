/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  billingAuthorityAccountIds,
  billingAuthorityActorAccountId,
} from "./protocol";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";

describe("billing authority account attribution", () => {
  it("indexes both actor and target for cross-account HTTP commands", () => {
    const command = {
      kind: "http" as const,
      operation: "cancel-payment-intent" as const,
      actor_account_id: ACTOR,
      input: {
        target_account_id: TARGET,
        id: "pi_1",
      },
    };
    expect(billingAuthorityActorAccountId(command)).toBe(ACTOR);
    expect(billingAuthorityAccountIds(command)).toEqual([TARGET, ACTOR]);
  });

  it("does not trust business metadata as actor or account identity", () => {
    const command = {
      kind: "http" as const,
      operation: "create-payment-intent" as const,
      input: {
        account_id: TARGET,
        metadata: {
          admin_account_id: ACTOR,
          actor_account_id: ACTOR,
          user_account_id: ACTOR,
        },
      },
    };
    expect(billingAuthorityActorAccountId(command)).toBeUndefined();
    expect(billingAuthorityAccountIds(command)).toEqual([TARGET]);
  });

  it("finds account metadata nested in modern Stripe invoices", () => {
    expect(
      billingAuthorityAccountIds({
        kind: "stripe-webhook",
        event: {
          id: "evt_1",
          data: {
            object: {
              parent: {
                invoice_details: { metadata: { account_id: TARGET } },
              },
            },
          },
        },
      }),
    ).toEqual([TARGET]);
  });
});
