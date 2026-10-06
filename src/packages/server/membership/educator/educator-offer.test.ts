/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import {
  createTestAccount,
  createTestMembershipTier,
} from "@cocalc/server/purchases/test-data";
import { computeMembershipChange } from "@cocalc/server/membership/tiers";
import {
  listMembershipPackageAssignments,
  resolveMembershipPackageQuote,
} from "@cocalc/server/membership/packages";
import purchaseMembershipPackage from "@cocalc/server/purchases/membership-package";

import { getAcademicDomainStatusFn } from "./academic-domains";
import { getEducatorEligibility } from "./eligibility";

const settingsOverrides: Record<string, unknown> = {};

jest.mock("@cocalc/database/settings/server-settings", () => {
  const actual = jest.requireActual(
    "@cocalc/database/settings/server-settings",
  );
  return {
    ...actual,
    getServerSettings: async () => ({
      ...(await actual.getServerSettings()),
      ...settingsOverrides,
    }),
  };
});

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);
afterAll(after);

async function accountWithVerifiedEmail(email: string): Promise<string> {
  const account_id = uuid();
  await createTestAccount(account_id);
  await getPool().query(
    `UPDATE accounts
        SET email_address=$1, email_address_verified=$2::jsonb
      WHERE account_id=$3`,
    [email, { [email]: new Date().toISOString() }, account_id],
  );
  return account_id;
}

async function createEducatorTier(
  overrides: Parameters<typeof createTestMembershipTier>[0] | object = {},
) {
  const id = `educator-${uuid().slice(0, 8)}`;
  await createTestMembershipTier({
    id,
    priority: 24,
    price_monthly: 25,
    price_yearly: 225,
    instructor_purchase_visible: true,
    instructor_term_price: 60,
    instructor_term_days: 122,
    ...overrides,
  });
  return id;
}

describe("academic domain list", () => {
  it("follows swot rules, including subdomains and the abuse list", async () => {
    const status = await getAcademicDomainStatusFn();
    expect(status("ucla.edu")).toBe("academic");
    expect(status("g.ucla.edu")).toBe("academic");
    expect(status("math.ox.ac.uk")).toBe("academic");
    expect(status("gmail.com")).toBe("not_academic");
    expect(status("alumnos.uai.edu.ar")).toBe("abused");
    expect(status("")).toBe("not_academic");
  });
});

describe("educator offers", () => {
  beforeEach(() => {
    for (const key of Object.keys(settingsOverrides)) {
      delete settingsOverrides[key];
    }
  });

  it("decides eligibility from the verified email and admin lists", async () => {
    const prof = await accountWithVerifiedEmail(`p-${uuid()}@g.ucla.edu`);
    const gmail = `t-${uuid().slice(0, 8)}@gmail.com`;
    const teacher = await accountWithVerifiedEmail(gmail);
    expect(await getEducatorEligibility({ account_id: prof })).toMatchObject({
      eligible: true,
      reason: "academic_domain",
    });
    expect(await getEducatorEligibility({ account_id: teacher })).toMatchObject(
      { eligible: false, reason: "not_academic" },
    );
    settingsOverrides.educator_email_allow_list = gmail;
    expect(await getEducatorEligibility({ account_id: teacher })).toMatchObject(
      { eligible: true, reason: "allowed_address" },
    );
    settingsOverrides.educator_email_deny_list = "*.ucla.edu";
    expect(await getEducatorEligibility({ account_id: prof })).toMatchObject({
      eligible: false,
      reason: "denied",
    });
  });

  it("sells a hidden tier by subscription only to eligible educators", async () => {
    const tier = await createEducatorTier();
    const prof = await accountWithVerifiedEmail(`p-${uuid()}@ucla.edu`);
    const other = await accountWithVerifiedEmail(`o-${uuid()}@example.com`);
    const quote = await computeMembershipChange({
      account_id: prof,
      targetClass: tier as any,
      interval: "month",
      storeVisibleOnly: true,
    });
    expect(quote.price).toBe(25);
    await expect(
      computeMembershipChange({
        account_id: other,
        targetClass: tier as any,
        interval: "year",
        storeVisibleOnly: true,
      }),
    ).rejects.toThrow("recognized academic institution");

    const hidden = await createEducatorTier({
      instructor_purchase_visible: false,
    });
    await expect(
      computeMembershipChange({
        account_id: prof,
        targetClass: hidden as any,
        interval: "month",
        storeVisibleOnly: true,
      }),
    ).rejects.toThrow("is not available");
  });

  it("quotes a one-seat fixed term from the tier's term price and length", async () => {
    const tier = await createEducatorTier();
    const before = Date.now();
    const quote = await resolveMembershipPackageQuote({
      type: "membership-package",
      kind: "team",
      membership_class: tier,
      seat_count: 1,
      metadata: { educator_term: true },
    });
    expect(quote).toMatchObject({
      kind: "team",
      membership_class: tier,
      seat_count: 1,
      seat_price: 60,
      total_price: 60,
      metadata: expect.objectContaining({
        educator_term: true,
        educator_term_days: 122,
      }),
    });
    const days =
      (new Date(quote.expires_at!).valueOf() -
        new Date(quote.starts_at!).valueOf()) /
      86_400_000;
    expect(days).toBeCloseTo(122, 3);
    expect(new Date(quote.starts_at!).valueOf()).toBeGreaterThanOrEqual(
      before - 1000,
    );

    await expect(
      resolveMembershipPackageQuote({
        type: "membership-package",
        kind: "team",
        membership_class: tier,
        seat_count: 3,
        metadata: { educator_term: true },
      }),
    ).rejects.toThrow("exactly one person");

    const noTerm = await createEducatorTier({
      instructor_term_price: undefined,
    });
    await expect(
      resolveMembershipPackageQuote({
        type: "membership-package",
        kind: "team",
        membership_class: noTerm,
        seat_count: 1,
        metadata: { educator_term: true },
      }),
    ).rejects.toThrow("no instructor term price");

    const notOffered = await createEducatorTier({
      instructor_purchase_visible: false,
    });
    await expect(
      resolveMembershipPackageQuote({
        type: "membership-package",
        kind: "team",
        membership_class: notOffered,
        seat_count: 1,
        metadata: { educator_term: true },
      }),
    ).rejects.toThrow("not available for instructor purchase");
  });

  it("sells the term only to eligible buyers and gives them the seat", async () => {
    const tier = await createEducatorTier({ instructor_term_price: 0 });
    const product = {
      type: "membership-package" as const,
      kind: "team" as const,
      membership_class: tier,
      seat_count: 1,
      metadata: { educator_term: true },
    };
    const other = await accountWithVerifiedEmail(`o-${uuid()}@example.com`);
    await expect(
      purchaseMembershipPackage({ account_id: other, product }),
    ).rejects.toThrow("recognized academic institution");

    const prof = await accountWithVerifiedEmail(`p-${uuid()}@ucla.edu`);
    const { package_id } = await purchaseMembershipPackage({
      account_id: prof,
      product,
    });
    const assignments = await listMembershipPackageAssignments({ package_id });
    expect(assignments.map((a) => a.account_id)).toEqual([prof]);
    await expect(
      resolveMembershipPackageQuote({ ...product, package_id }),
    ).rejects.toThrow("cannot add seats to an educator term");
  });

  it("rolls back the whole purchase if seat assignment fails, so a retry charges once", async () => {
    const tier = await createEducatorTier({ instructor_term_price: 0 });
    const product = {
      type: "membership-package" as const,
      kind: "team" as const,
      membership_class: tier,
      seat_count: 1,
      metadata: { educator_term: true },
    };
    const prof = await accountWithVerifiedEmail(`p-${uuid()}@ucla.edu`);
    const packages = jest.requireActual("@cocalc/server/membership/packages");
    const spy = jest
      .spyOn(packages, "assignMembershipPackageSeat")
      .mockRejectedValueOnce(new Error("transient seat failure"));
    try {
      await expect(
        purchaseMembershipPackage({ account_id: prof, product }),
      ).rejects.toThrow("transient seat failure");
    } finally {
      spy.mockRestore();
    }
    const count = async () => {
      const { rows } = await getPool().query(
        `SELECT
           (SELECT COUNT(*) FROM membership_packages WHERE owner_account_id=$1)::int AS packages,
           (SELECT COUNT(*) FROM purchases WHERE account_id=$1)::int AS purchases`,
        [prof],
      );
      return rows[0];
    };
    expect(await count()).toEqual({ packages: 0, purchases: 0 });

    const { package_id } = await purchaseMembershipPackage({
      account_id: prof,
      product,
    });
    expect(await count()).toEqual({ packages: 1, purchases: 1 });
    const assignments = await listMembershipPackageAssignments({ package_id });
    expect(assignments.map((a) => a.account_id)).toEqual([prof]);
  });
});
