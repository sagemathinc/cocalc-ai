/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  getTransactionClient,
  initEphemeralDatabase,
  type PoolClient,
} from "@cocalc/database/pool";
import { uuid } from "@cocalc/util/misc";
import {
  packageAssignmentAllocationInterval,
  packageAssignmentAllocationMonths,
  packageAssignmentAllocationSource,
  recordPackageAssignmentMonth,
  type PackageAssignmentAllocationSource,
} from "./package-assignment-analytics";

function source(
  overrides: Partial<PackageAssignmentAllocationSource> = {},
): PackageAssignmentAllocationSource {
  return {
    assignment_id: uuid(),
    account_id: uuid(),
    assigned_at: "2026-07-17T18:00:00Z",
    package_kind: "team",
    membership_class: "standard",
    ...overrides,
  };
}

describe("membership package assignment analytics", () => {
  it("uses claimed time and package bounds for monthly segments", () => {
    const assignment = source({
      assigned_at: "2026-06-01T00:00:00Z",
      assignment_metadata: { claimed_at: "2026-07-17T18:00:00Z" },
      package_starts_at: "2026-07-01T00:00:00Z",
      package_expires_at: "2026-09-12T00:00:00Z",
    });
    expect(
      packageAssignmentAllocationInterval({
        source: assignment,
        month: "2026-07",
      }),
    ).toEqual({
      month: "2026-07",
      allocation_start: "2026-07-17",
      allocation_end: "2026-08-01",
    });
    expect(
      packageAssignmentAllocationInterval({
        source: assignment,
        month: "2026-09",
      }),
    ).toEqual({
      month: "2026-09",
      allocation_start: "2026-09-01",
      allocation_end: "2026-09-12",
    });
  });

  it("lists only months through revocation or the requested horizon", () => {
    expect(
      packageAssignmentAllocationMonths({
        source: source({ revoked_at: "2026-09-03T12:00:00Z" }),
        through: "2027-01-01",
      }),
    ).toEqual(["2026-07", "2026-08", "2026-09"]);
  });

  it("does not duplicate direct student purchase assignments", () => {
    expect(
      packageAssignmentAllocationSource({
        pkg: {
          id: uuid(),
          owner_account_id: uuid(),
          kind: "course",
          membership_class: "student",
          seat_count: 1,
          metadata: { direct_student_purchase: true },
        },
        assignment: {
          id: uuid(),
          package_id: uuid(),
          account_id: uuid(),
          assigned_at: new Date(),
        },
      }),
    ).toBeUndefined();
  });

  describe("database facts", () => {
    let client: PoolClient;

    beforeAll(async () => {
      await initEphemeralDatabase({});
      client = await getTransactionClient();
    }, 30_000);

    afterAll(async () => {
      await client.query("ROLLBACK");
      client.release();
    }, 30_000);

    it("records one assignment and one revocation correction idempotently", async () => {
      const assignment = source({
        assignment_id: uuid(),
        account_id: uuid(),
        package_kind: "site",
        membership_class: "standard",
        assignment_metadata: { grant_membership_class: "pro" },
        revoked_at: "2026-07-25T12:00:00Z",
      });
      expect(
        await recordPackageAssignmentMonth({
          source: assignment,
          month: "2026-07",
          client,
        }),
      ).toEqual({ assignment: true, correction: true });
      expect(
        await recordPackageAssignmentMonth({
          source: assignment,
          month: "2026-07",
          client,
        }),
      ).toEqual({ assignment: false, correction: false });

      const { rows } = await client.query(
        `SELECT channel, source_kind, membership_class, allocation_start,
                allocation_end, active_memberships, purchased_capacity,
                revenue_cents
           FROM membership_allocation_facts
          WHERE fact_key LIKE $1
          ORDER BY source_kind`,
        [`package-assignment:${assignment.assignment_id}:%`],
      );
      expect(rows).toEqual([
        {
          channel: "site",
          source_kind: "assignment",
          membership_class: "pro",
          allocation_start: new Date("2026-07-17T00:00:00.000Z"),
          allocation_end: new Date("2026-08-01T00:00:00.000Z"),
          active_memberships: 1,
          purchased_capacity: 0,
          revenue_cents: "0",
        },
        {
          channel: "site",
          source_kind: "correction",
          membership_class: "pro",
          allocation_start: new Date("2026-07-25T00:00:00.000Z"),
          allocation_end: new Date("2026-08-01T00:00:00.000Z"),
          active_memberships: -1,
          purchased_capacity: 0,
          revenue_cents: "0",
        },
      ]);
    });

    it("classifies standalone team grants as fixed and license seats as annual", async () => {
      const standalone = source({ assignment_id: uuid() });
      const licensed = source({
        assignment_id: uuid(),
        package_metadata: { team_license_id: uuid() },
      });
      await recordPackageAssignmentMonth({
        source: standalone,
        month: "2026-07",
        client,
      });
      await recordPackageAssignmentMonth({
        source: licensed,
        month: "2026-07",
        client,
      });
      const { rows } = await client.query(
        `SELECT fact_key, billing_interval
           FROM membership_allocation_facts
          WHERE fact_key = ANY($1::text[])
          ORDER BY fact_key`,
        [
          [
            `package-assignment:${standalone.assignment_id}:2026-07`,
            `package-assignment:${licensed.assignment_id}:2026-07`,
          ],
        ],
      );
      expect(
        new Map(rows.map((row) => [row.fact_key, row.billing_interval])),
      ).toEqual(
        new Map([
          [`package-assignment:${standalone.assignment_id}:2026-07`, "fixed"],
          [`package-assignment:${licensed.assignment_id}:2026-07`, "year"],
        ]),
      );
    });
  });
});
