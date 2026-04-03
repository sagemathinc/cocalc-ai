/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { AccountActions } from "./actions";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    account_id: undefined,
    conat_client: {
      hub: {
        system: {
          getAccountBay: jest.fn(),
        },
      },
    },
  },
}));

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

describe("AccountActions.refresh_home_bay", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("stores the resolved home bay for the signed-in account", async () => {
    const setState = jest.fn();
    (webapp_client as any).account_id = "acct-1";
    (
      webapp_client as any
    ).conat_client.hub.system.getAccountBay.mockResolvedValue({
      account_id: "acct-1",
      home_bay_id: "bay-7",
      source: "account-row",
    });

    await AccountActions.prototype.refresh_home_bay.call({ setState });

    expect(
      (webapp_client as any).conat_client.hub.system.getAccountBay,
    ).toHaveBeenCalledWith({
      user_account_id: "acct-1",
    });
    expect(setState).toHaveBeenCalledWith({
      home_bay_id: "bay-7",
      home_bay_source: "account-row",
    });
  });

  it("clears the stored home bay when no account is signed in", async () => {
    const setState = jest.fn();
    (webapp_client as any).account_id = undefined;

    await AccountActions.prototype.refresh_home_bay.call({ setState });

    expect(
      (webapp_client as any).conat_client.hub.system.getAccountBay,
    ).not.toHaveBeenCalled();
    expect(setState).toHaveBeenCalledWith({
      home_bay_id: undefined,
      home_bay_source: undefined,
    });
  });
});
