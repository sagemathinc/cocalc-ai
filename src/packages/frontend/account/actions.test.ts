/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { AccountActions } from "./actions";

describe("AccountActions.set_other_settings", () => {
  it("replaces the nested other_settings object instead of deep-merging it", () => {
    const set = jest.fn();
    const launcher = {
      perProject: {
        p1: {
          quickCreate: [],
          hiddenQuickCreate: ["rmd", "qmd", "slides", "py"],
          quickCreateOrder: [],
        },
      },
    };
    const redux = {
      getStore: () => ({
        get: (name: string) =>
          name === "other_settings"
            ? {
                toJS: () => ({
                  vertical_fixed_bar: "both",
                  launcher: {
                    perProject: {
                      p1: {
                        quickCreate: ["rmd", "qmd", "slides", "py"],
                        hiddenQuickCreate: [],
                        quickCreateOrder: ["rmd", "qmd", "slides", "py"],
                      },
                    },
                  },
                }),
              }
            : undefined,
      }),
      getTable: () => ({ set }),
    };

    AccountActions.prototype.set_other_settings.call(
      { redux },
      "launcher",
      launcher,
    );

    expect(set).toHaveBeenCalledWith(
      {
        other_settings: {
          vertical_fixed_bar: "both",
          launcher,
        },
      },
      "shallow",
    );
  });
});
