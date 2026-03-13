/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { AccountTable } from "./table";

describe("AccountTable._change", () => {
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

    AccountTable.prototype._change.call(
      { redux, first_set: true },
      {
        get_one: () => ({
          toJS: () => ({
            other_settings: { auto_update_file_listing: true },
          }),
        }),
      },
    );

    expect(setState).toHaveBeenNthCalledWith(1, {
      other_settings: {
        auto_update_file_listing: true,
        vertical_fixed_bar: "both",
      },
    });
    expect(setState).toHaveBeenNthCalledWith(2, { is_ready: true });
    expect(emit).toHaveBeenCalledWith("is_ready");
  });
});
