import {
  generateCustomerFixtures,
  applyCustomerFixtures,
  assertFixtureEnvironment,
} from "./development-fixtures";

const actor = "11111111-1111-4111-a111-111111111111";
const date = new Date("2026-09-05T00:00:00Z");
describe("local customer fixtures", () => {
  it("requires explicit confirmation on a non-production seed bay", () => {
    const confirm = "seed-local-customer-fixtures";
    expect(() =>
      assertFixtureEnvironment("production", confirm, "seed", "seed"),
    ).toThrow("non-production");
    expect(() =>
      assertFixtureEnvironment("development", undefined, "seed", "seed"),
    ).toThrow("confirm");
    expect(() =>
      assertFixtureEnvironment("development", confirm, "attached", "seed"),
    ).toThrow("seed bay");
    expect(() =>
      assertFixtureEnvironment("development", confirm, "seed", "seed"),
    ).not.toThrow();
  });
  it("is deterministic and includes enough linked records for pagination", () => {
    const fixture = generateCustomerFixtures(actor, date);
    expect(fixture).toEqual(generateCustomerFixtures(actor, date));
    expect(fixture).toHaveLength(240);
    const ids = new Set(fixture.map(({ row }) => row.id));
    expect(ids.size).toBe(240);
    for (const { row } of fixture) {
      for (const key of [
        "organization_id",
        "crm_organization_id",
        "person_id",
        "crm_person_id",
        "commercial_order_id",
        "opportunity_id",
      ]) {
        if (row[key]) expect(ids.has(row[key] as string)).toBe(true);
      }
    }
  });
  it("does not create provider, payment, entitlement or deliverable email records", () => {
    const fixture = generateCustomerFixtures(actor, date);
    expect(
      fixture.some(({ table }) =>
        /invoice|payment|outreach|license/.test(table),
      ),
    ).toBe(false);
    for (const { table, row } of fixture) {
      if (table === "commercial_orders") {
        expect(row.collection_mode).toBe("manual_invoice");
        expect(row.stripe_customer_id).toBeUndefined();
        expect(row.customer_account_id).toBeUndefined();
        expect(row.workflow_state).toBeUndefined(); // schema default is draft
      }
      for (const key of ["email_address", "email_snapshot"])
        if (row[key]) expect(row[key]).toMatch(/@example\.invalid$/);
    }
  });
  it("never overwrites existing fixture edits", async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 0 });
    await expect(
      applyCustomerFixtures(
        { query } as any,
        generateCustomerFixtures(actor, date),
      ),
    ).resolves.toBe(0);
    expect(query).toHaveBeenCalledTimes(240);
    for (const [sql] of query.mock.calls)
      expect(sql).toContain("ON CONFLICT (id) DO NOTHING");
  });
  it("rejects invalid inputs", () => {
    expect(() => generateCustomerFixtures("bad", date)).toThrow("UUID");
    expect(() => generateCustomerFixtures(actor, new Date("bad"))).toThrow(
      "date",
    );
  });
});
