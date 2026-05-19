/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const RELATED_ID = "22222222-2222-4222-8222-222222222222";
const UNRELATED_ID = "33333333-3333-4333-8333-333333333333";

describe("filterAccountSearchResultsToRelated", () => {
  it("keeps self and current collaborators", async () => {
    const query = jest.fn(async () => ({
      rows: [{ collaborator_account_id: RELATED_ID }],
    }));
    const { filterAccountSearchResultsToRelated } =
      await import("./search-policy");

    await expect(
      filterAccountSearchResultsToRelated({
        account_id: ACCOUNT_ID,
        rows: [
          { account_id: ACCOUNT_ID },
          { account_id: RELATED_ID },
          { account_id: UNRELATED_ID },
        ],
        db: { query },
      }),
    ).resolves.toEqual([
      { account_id: ACCOUNT_ID },
      { account_id: RELATED_ID },
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("ANY"), [
      ACCOUNT_ID,
      [RELATED_ID, UNRELATED_ID],
    ]);
  });

  it("fails closed to self only if relationship lookup fails", async () => {
    const query = jest.fn(async () => {
      throw new Error("missing projection");
    });
    const { filterAccountSearchResultsToRelated } =
      await import("./search-policy");

    await expect(
      filterAccountSearchResultsToRelated({
        account_id: ACCOUNT_ID,
        rows: [{ account_id: ACCOUNT_ID }, { account_id: RELATED_ID }],
        db: { query },
      }),
    ).resolves.toEqual([{ account_id: ACCOUNT_ID }]);
  });
});

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
