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
