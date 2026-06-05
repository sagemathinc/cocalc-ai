/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { AccountActions } from "./actions";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import api from "@cocalc/frontend/client/api";

jest.mock("@cocalc/frontend/client/api", () => ({
  __esModule: true,
  default: jest.fn(),
}));

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
    let currentOtherSettings: Record<string, any> = {
      vertical_fixed_bar: "both",
      launcher: {
        quickCreate: ["chat", "ipynb"],
      },
    };
    const set = jest.fn((obj) => {
      currentOtherSettings = obj.other_settings;
    });
    const launcher = {
      quickCreate: ["rmd", "qmd", "slides", "py"],
    };
    const redux = {
      getStore: () => ({
        get: (name: string) =>
          name === "other_settings"
            ? {
                get: (key: string) => currentOtherSettings[key],
                toJS: () => currentOtherSettings,
              }
            : undefined,
      }),
      getTable: () => ({ set }),
    };

    const actions = Object.create(AccountActions.prototype);
    actions.redux = redux;

    actions.set_other_settings("launcher", launcher);

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

  it("stores a cluster-directory resolved home bay source", async () => {
    const setState = jest.fn();
    (webapp_client as any).account_id = "acct-1";
    (
      webapp_client as any
    ).conat_client.hub.system.getAccountBay.mockResolvedValue({
      account_id: "acct-1",
      home_bay_id: "bay-7",
      source: "cluster-directory",
    });

    await AccountActions.prototype.refresh_home_bay.call({ setState });

    expect(setState).toHaveBeenCalledWith({
      home_bay_id: "bay-7",
      home_bay_source: "cluster-directory",
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

describe("AccountActions.delete_account", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rethrows fresh-auth errors so the UI can open the fresh-auth modal", async () => {
    const freshAuthError = Object.assign(new Error("fresh auth is required"), {
      code: "fresh_auth_required",
    });
    (api as jest.Mock).mockRejectedValue(freshAuthError);
    const setState = jest.fn();

    await expect(
      AccountActions.prototype.delete_account.call({ setState }),
    ).rejects.toBe(freshAuthError);

    expect(setState).toHaveBeenCalledWith({
      account_deletion_error: undefined,
    });
    expect(setState).toHaveBeenCalledTimes(1);
  });

  it("still stores non-fresh-auth deletion errors inline", async () => {
    (api as jest.Mock).mockRejectedValue(new Error("server exploded"));
    const setState = jest.fn();

    await AccountActions.prototype.delete_account.call({ setState });

    expect(setState).toHaveBeenCalledWith({
      account_deletion_error: undefined,
    });
    expect(setState).toHaveBeenCalledWith({
      account_deletion_error:
        "Error trying to delete the account: server exploded",
    });
  });
});
