/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let getClusterAccountsByIdsMock: jest.Mock;
let poolQueryMock: jest.Mock;

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  __esModule: true,
  getClusterAccountByEmail: jest.fn(),
  getClusterAccountById: jest.fn(),
  getClusterAccountsByIds: (...args: any[]) =>
    getClusterAccountsByIdsMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: (...args: any[]) => poolQueryMock(...args),
  })),
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

describe("getNames input validation", () => {
  beforeEach(() => {
    getClusterAccountsByIdsMock = jest.fn(async () => []);
    poolQueryMock = jest.fn(async () => ({ rows: [] }));
  });

  it("validates account_id array shape and size", async () => {
    const { MAX_GET_NAMES_ACCOUNT_IDS, validateGetNamesAccountIds } =
      await import("./get-name");

    expect(() => validateGetNamesAccountIds("not-array")).toThrow(
      "account_ids must be an array",
    );
    expect(() =>
      validateGetNamesAccountIds(
        Array.from({ length: MAX_GET_NAMES_ACCOUNT_IDS + 1 }, () => ACCOUNT_ID),
      ),
    ).toThrow(`at most ${MAX_GET_NAMES_ACCOUNT_IDS} account_ids`);
    expect(() => validateGetNamesAccountIds(["not-a-uuid"])).toThrow(
      "account_ids[0] must be a valid uuid",
    );
  });

  it("normalizes and deduplicates valid account_ids", async () => {
    const { validateGetNamesAccountIds } = await import("./get-name");

    expect(
      validateGetNamesAccountIds([
        ` ${ACCOUNT_ID} `,
        ACCOUNT_ID,
        OTHER_ACCOUNT_ID,
      ]),
    ).toEqual([ACCOUNT_ID, OTHER_ACCOUNT_ID]);
  });

  it("enforces validation before querying names", async () => {
    const { getNames } = await import("./get-name");

    await expect(getNames(["not-a-uuid"])).rejects.toThrow(
      "account_ids[0] must be a valid uuid",
    );
    expect(getClusterAccountsByIdsMock).not.toHaveBeenCalled();
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it("queries with normalized account_ids", async () => {
    getClusterAccountsByIdsMock = jest.fn(async () => [
      {
        account_id: ACCOUNT_ID,
        first_name: "Ada",
        last_name: "Lovelace",
      },
    ]);
    const { getNames } = await import("./get-name");

    const names = await getNames([` ${ACCOUNT_ID} `, ACCOUNT_ID]);

    expect(getClusterAccountsByIdsMock).toHaveBeenCalledWith([ACCOUNT_ID]);
    expect(names[ACCOUNT_ID]).toEqual({
      first_name: "Ada",
      last_name: "Lovelace",
      profile: undefined,
    });
  });
});
