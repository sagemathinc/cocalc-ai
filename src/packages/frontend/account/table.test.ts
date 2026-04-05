/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { AccountTable, applyAccountPatch } from "./table";

describe("AccountTable", () => {
  it("requests home_bay_id in the synced account query", () => {
    const query = AccountTable.prototype.query.call({});
    expect(query.accounts[0]).toMatchObject({
      account_id: null,
      home_bay_id: null,
    });
  });

  it("uses snapshot-only account bootstrap without a changefeed", () => {
    expect(AccountTable.prototype.no_changefeed.call({})).toBe(true);
  });

  it("merges partial other_settings updates into the current store state", () => {
    const setState = jest.fn();
    const emit = jest.fn();
    const redux = {
      getActions: () => ({ setState }),
      getStore: () => ({
        get: (name: string) =>
          name === "other_settings"
            ? { toJS: () => ({ vertical_fixed_bar: "both" }) }
            : undefined,
        emit,
      }),
    };

    applyAccountPatch({
      redux,
      patch: {
        other_settings: { auto_update_file_listing: true },
      },
      first_set: true,
    });

    expect(setState).toHaveBeenNthCalledWith(1, {
      other_settings: {
        auto_update_file_listing: true,
        vertical_fixed_bar: "both",
      },
    });
    expect(setState).toHaveBeenNthCalledWith(2, { is_ready: true });
    expect(emit).toHaveBeenCalledWith("is_ready");
  });

  it("derives the stored home bay source from synced account rows", () => {
    const setState = jest.fn();
    const emit = jest.fn();
    const redux = {
      getActions: () => ({ setState }),
      getStore: () => ({
        get: () => undefined,
        emit,
      }),
    };

    applyAccountPatch({
      redux,
      patch: {
        home_bay_id: "bay-7",
      },
    });

    expect(setState).toHaveBeenCalledWith({
      home_bay_id: "bay-7",
      home_bay_source: "account-row",
    });
  });
});
