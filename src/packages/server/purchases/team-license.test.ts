/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { before, after, getPool } from "@cocalc/server/test";
import {
  createTestAccount,
  createTestMembershipTier,
} from "@cocalc/server/purchases/test-data";
import { applyTeamLicenseSeatConfiguration } from "@cocalc/server/membership/team-licenses";
import { uuid } from "@cocalc/util/misc";
import createPurchase from "./create-purchase";

const mockCreatePaymentIntent = jest.fn();
const mockSend = jest.fn();
const mockSupport = jest.fn();
const mockUrl = jest.fn();

jest.mock("./stripe/create-payment-intent", () => ({
  __esModule: true,
  default: (...args: any[]) => mockCreatePaymentIntent(...args),
}));

jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: (...args: any[]) => mockSend(...args),
  support: (...args: any[]) => mockSupport(...args),
  url: (...args: any[]) => mockUrl(...args),
}));

import {
  createTeamLicenseRenewalPayment,
  processTeamLicenseRenewal,
} from "./team-license";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);

afterAll(after);

describe("team license renewal payments", () => {
  const teamTier = `team-license-renewal-${uuid()}`;

  beforeAll(async () => {
    await createTestMembershipTier({
      id: teamTier,
      priority: 30,
      price_yearly: 120,
      team_visible: true,
    });
  });

  beforeEach(() => {
    mockCreatePaymentIntent.mockReset().mockResolvedValue({
      hosted_invoice_url: "https://stripe.example/team-license",
      payment_intent: "pi_team_license",
    });
    mockSend.mockReset().mockResolvedValue(undefined);
    mockSupport.mockReset().mockResolvedValue("support");
    mockUrl.mockReset().mockImplementation(async (path) => path);
  });

  it("renews from account balance when enabled and fully covered", async () => {
    const owner_account_id = uuid();
    await createTestAccount(owner_account_id);
    await createPurchase({
      account_id: owner_account_id,
      client: null,
      cost: -500,
      description: {},
      service: "credit",
    });
    const overview = await applyTeamLicenseSeatConfiguration({
      owner_account_id,
      target_seats: {
        [teamTier]: 2,
      },
    });

    await createTeamLicenseRenewalPayment({
      owner_account_id,
      team_license_id: overview.id,
    });

    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
    const renewed = await getPool().query(
      "SELECT current_period_start, current_period_end, payment FROM team_licenses WHERE id=$1",
      [overview.id],
    );
    expect(renewed.rows[0].payment).toBeNull();
    expect(new Date(renewed.rows[0].current_period_start).toISOString()).toBe(
      new Date(overview.current_period_end).toISOString(),
    );
    const purchases = await getPool().query(
      "SELECT cost FROM purchases WHERE account_id=$1 AND tag='team-license-renewal'",
      [owner_account_id],
    );
    expect(Number(purchases.rows[0].cost)).toBe(240);
  });

  it("does not fail a committed renewal when the success notification fails", async () => {
    const owner_account_id = uuid();
    await createTestAccount(owner_account_id);
    const overview = await applyTeamLicenseSeatConfiguration({
      owner_account_id,
      target_seats: {
        [teamTier]: 1,
      },
    });
    mockSend.mockRejectedValueOnce(new Error("message delivery failed"));

    await expect(
      processTeamLicenseRenewal({
        account_id: owner_account_id,
        amount: 120,
        paymentIntent: {
          id: "pi_team_license_success_notification_failed",
          metadata: { team_license_id: overview.id },
        },
      }),
    ).resolves.toBeUndefined();

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Team License Renewed",
        to_ids: [owner_account_id],
      }),
    );
    const { rows } = await getPool().query(
      `
        SELECT current_period_start, current_period_end, payment
          FROM team_licenses
         WHERE id=$1
      `,
      [overview.id],
    );
    expect(rows[0].payment).toBeNull();
    expect(new Date(rows[0].current_period_start).toISOString()).toBe(
      new Date(overview.current_period_end).toISOString(),
    );
    const purchases = await getPool().query(
      "SELECT COUNT(*)::int AS count FROM purchases WHERE account_id=$1 AND tag='team-license-renewal'",
      [owner_account_id],
    );
    expect(purchases.rows[0].count).toBe(1);
  });

  it("creates a payment intent when the team balance setting is disabled", async () => {
    const owner_account_id = uuid();
    await createTestAccount(owner_account_id);
    await getPool().query(
      `
        UPDATE accounts
           SET other_settings=jsonb_set(
             COALESCE(other_settings, '{}'::jsonb),
             '{use_balance_toward_team_licenses}',
             'false'::jsonb
           )
         WHERE account_id=$1
      `,
      [owner_account_id],
    );
    await createPurchase({
      account_id: owner_account_id,
      client: null,
      cost: -500,
      description: {},
      service: "credit",
    });
    const overview = await applyTeamLicenseSeatConfiguration({
      owner_account_id,
      target_seats: {
        [teamTier]: 1,
      },
    });

    await createTeamLicenseRenewalPayment({
      owner_account_id,
      team_license_id: overview.id,
    });

    expect(mockCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: owner_account_id,
        lineItems: expect.arrayContaining([
          expect.objectContaining({ amount: 120 }),
        ]),
        metadata: {
          team_license_id: overview.id,
        },
        processImmediately: false,
      }),
    );
    const { rows } = await getPool().query(
      "SELECT payment FROM team_licenses WHERE id=$1",
      [overview.id],
    );
    expect(rows[0].payment).toMatchObject({
      amount: 120,
      payment_intent_id: "pi_team_license",
      status: "active",
      team_license_id: overview.id,
    });
  });
});
