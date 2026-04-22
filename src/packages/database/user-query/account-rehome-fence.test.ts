/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let mockAccountFence: jest.Mock;

jest.mock("@cocalc/database/postgres/account-rehome-fence", () => ({
  withAccountRehomeUserQueryFence: (...args: any[]) =>
    mockAccountFence(...args),
}));

import { user_set_query } from "./methods-impl";

describe("user_set_query account rehome fence", () => {
  beforeEach(() => {
    mockAccountFence = jest.fn(async ({ fn }) => await fn());
  });

  function makeContext(r: any): any {
    return {
      _parse_set_query_opts: jest.fn(() => r),
      _user_set_query_enforce_requirements: jest.fn((_opts, cb) => cb()),
      _user_set_query_hooks_prepare: jest.fn((_opts, cb) => cb()),
      _user_set_query_main_query: jest.fn((_opts, cb) => cb()),
      _dbg: jest.fn(() => jest.fn()),
    };
  }

  it("wraps accounts mutations in the account rehome fence", async () => {
    const r = {
      db_table: "accounts",
      account_id: "11111111-1111-4111-8111-111111111111",
      query: {
        account_id: "11111111-1111-4111-8111-111111111111",
        first_name: "Ada",
      },
    };
    const context = makeContext(r);

    await user_set_query.call(context, {
      account_id: "11111111-1111-4111-8111-111111111111",
      table: "accounts",
      query: r.query,
      cb: jest.fn(),
    });

    expect(mockAccountFence).toHaveBeenCalledWith(
      expect.objectContaining({
        database: context,
        account_id: "11111111-1111-4111-8111-111111111111",
      }),
    );
    expect(context._user_set_query_main_query).toHaveBeenCalledWith(
      r,
      expect.any(Function),
    );
  });

  it("does not fence non-account mutations", async () => {
    const r = {
      db_table: "projects",
      account_id: "11111111-1111-4111-8111-111111111111",
      query: {
        project_id: "22222222-2222-4222-8222-222222222222",
        title: "Project",
      },
    };
    const context = makeContext(r);

    await user_set_query.call(context, {
      account_id: "11111111-1111-4111-8111-111111111111",
      table: "projects",
      query: r.query,
      cb: jest.fn(),
    });

    expect(mockAccountFence).not.toHaveBeenCalled();
    expect(context._user_set_query_main_query).toHaveBeenCalledWith(
      r,
      expect.any(Function),
    );
  });
});
