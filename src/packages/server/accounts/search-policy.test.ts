/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const RELATED_ID = "22222222-2222-4222-8222-222222222222";

describe("searchRelatedClusterAccounts", () => {
  it("filters collaborators in SQL before applying the limit", async () => {
    const query = jest.fn(async () => ({
      rows: [
        {
          account_id: RELATED_ID,
          first_name: "William",
          last_name: "Collaborator",
          email_address: "william@example.com",
          created: new Date("2026-01-01T00:00:00Z"),
          last_active: new Date("2026-01-02T00:00:00Z"),
        },
      ],
    }));
    const { searchRelatedClusterAccounts } = await import("./search-policy");

    const result = await searchRelatedClusterAccounts({
      account_id: ACCOUNT_ID,
      query: "William",
      limit: 10,
      db: { query },
      ensureDirectorySchema: async () => {},
    });
    expect(result).toEqual([
      expect.objectContaining({
        account_id: RELATED_ID,
        first_name: "William",
        last_active: new Date("2026-01-02T00:00:00Z").valueOf(),
      }),
    ]);
    expect(result[0]).not.toHaveProperty("email_address");

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("WITH related AS");
    expect(sql).toContain("account_collaborator_index");
    expect(sql).toContain("LIMIT $3::INTEGER");
    expect(params).toEqual([ACCOUNT_ID, "%william%", 10, expect.any(String)]);
  });

  it("keeps exact related email matches visible", async () => {
    const query = jest.fn(async () => ({
      rows: [
        {
          account_id: RELATED_ID,
          first_name: "Related",
          email_address: "related@example.com",
          matched_email: true,
        },
      ],
    }));
    const { searchRelatedClusterAccounts } = await import("./search-policy");

    await expect(
      searchRelatedClusterAccounts({
        account_id: ACCOUNT_ID,
        query: "related@example.com",
        db: { query },
        ensureDirectorySchema: async () => {},
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        account_id: RELATED_ID,
        email_address: "related@example.com",
      }),
    ]);
  });
});
