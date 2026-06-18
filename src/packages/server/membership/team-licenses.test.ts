/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { before, after } from "@cocalc/server/test";
import {
  createTestAccount,
  createTestMembershipTier,
} from "@cocalc/server/purchases/test-data";
import { uuid } from "@cocalc/util/misc";
import { assignMembershipPackageSeat } from "./packages";
import { resolveMembershipForAccount } from "./resolve";
import {
  applyTeamLicenseSeatConfiguration,
  markTeamLicensePastDue,
  resolveTeamLicenseQuote,
} from "./team-licenses";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);

afterAll(after);

describe("team licenses", () => {
  const standardTier = `team-license-standard-${uuid()}`;
  const proTier = `team-license-pro-${uuid()}`;

  beforeAll(async () => {
    await createTestMembershipTier({
      id: standardTier,
      priority: 30,
      price_yearly: 120,
      team_visible: true,
    });
    await createTestMembershipTier({
      id: proTier,
      priority: 40,
      price_yearly: 300,
      team_visible: true,
    });
  });

  it("creates one parent license with seat lines backed by membership packages", async () => {
    const owner_account_id = uuid();
    const member_account_id = uuid();
    await createTestAccount(owner_account_id);
    await createTestAccount(member_account_id);

    const quote = await resolveTeamLicenseQuote({
      owner_account_id,
      target_seats: {
        [standardTier]: 2,
        [proTier]: 1,
      },
    });
    expect(quote.line_items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: `2 ${standardTier} annual team seats at $120/seat`,
        }),
        expect.objectContaining({
          description: `1 ${proTier} annual team seat at $300/seat`,
        }),
      ]),
    );

    const overview = await applyTeamLicenseSeatConfiguration({
      owner_account_id,
      target_seats: {
        [standardTier]: 2,
        [proTier]: 1,
      },
    });

    expect(overview.owner_account_id).toBe(owner_account_id);
    expect(overview.status).toBe("active");
    expect(overview.seat_lines).toHaveLength(2);
    expect(overview.packages).toHaveLength(2);

    const standardLine = overview.seat_lines.find(
      (line) => line.membership_class === standardTier,
    );
    expect(standardLine?.seat_count).toBe(2);
    expect(standardLine?.package?.kind).toBe("team");
    expect(standardLine?.package?.expires_at ?? null).toBeNull();
    expect(standardLine?.package?.metadata?.team_license_id).toBe(overview.id);

    const assignment = await assignMembershipPackageSeat({
      package_id: standardLine!.package_id!,
      account_id: member_account_id,
      assigned_by_account_id: owner_account_id,
    });
    expect(assignment.grant_source).toBe("team-seat");

    const membership = await resolveMembershipForAccount(member_account_id);
    expect(membership.class).toBe(standardTier);
    expect(membership.source).toBe("grant");
    expect(membership.grant_package_id).toBe(standardLine!.package_id);
    expect(membership.team_license_id).toBe(overview.id);
    expect(membership.team_license_status).toBe("active");
    expect(membership.expires).toBeUndefined();
  });

  it("keeps assigned seats active when renewal marks a team license past due", async () => {
    const owner_account_id = uuid();
    const member_account_id = uuid();
    await createTestAccount(owner_account_id);
    await createTestAccount(member_account_id);

    const overview = await applyTeamLicenseSeatConfiguration({
      owner_account_id,
      target_seats: {
        [proTier]: 1,
      },
    });
    const line = overview.seat_lines.find(
      (seatLine) => seatLine.membership_class === proTier,
    )!;

    await assignMembershipPackageSeat({
      package_id: line.package_id!,
      account_id: member_account_id,
      assigned_by_account_id: owner_account_id,
    });
    await markTeamLicensePastDue({
      team_license_id: overview.id,
      payment: {
        status: "canceled",
        error: "test renewal failure",
      },
    });

    const membership = await resolveMembershipForAccount(member_account_id);
    expect(membership.class).toBe(proTier);
    expect(membership.source).toBe("grant");
    expect(membership.team_license_id).toBe(overview.id);
    expect(membership.team_license_status).toBe("past_due");
    expect(membership.team_license_warning?.type).toBe("past_due");
    expect(membership.team_license_warning?.message).toContain(
      "Team License expired",
    );
  });

  it("does not allow reducing seats through the initial team-license model", async () => {
    const owner_account_id = uuid();
    await createTestAccount(owner_account_id);

    await applyTeamLicenseSeatConfiguration({
      owner_account_id,
      target_seats: {
        [standardTier]: 2,
      },
    });

    await expect(
      resolveTeamLicenseQuote({
        owner_account_id,
        target_seats: {
          [standardTier]: 1,
        },
      }),
    ).rejects.toThrow("team license seat reductions are not supported yet");
  });
});
