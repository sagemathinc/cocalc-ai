/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { AccountActions } from "./actions";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import api from "@cocalc/frontend/client/api";
import { refreshAccountSnapshot } from "./table";

const refreshAccountSnapshotMock =
  refreshAccountSnapshot as jest.MockedFunction<typeof refreshAccountSnapshot>;

jest.mock("@cocalc/frontend/client/api", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("./table", () => ({
  refreshAccountSnapshot: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    account_id: undefined,
    async_query: jest.fn(),
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
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("replaces the nested other_settings object instead of deep-merging it", async () => {
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

    await actions.set_other_settings_and_wait("launcher", launcher);

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

  it("sets related other_settings values in one table update", async () => {
    let currentOtherSettings: Record<string, any> = {
      vertical_fixed_bar: "both",
    };
    const set = jest.fn((obj) => {
      currentOtherSettings = obj.other_settings;
    });
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

    await actions.set_other_settings_many_and_wait({
      newsletter: true,
      marketing_email_consent_record: {
        version: 1,
        enabled: true,
      },
    });

    expect(set).toHaveBeenCalledWith(
      {
        other_settings: {
          vertical_fixed_bar: "both",
          newsletter: true,
          marketing_email_consent_record: {
            version: 1,
            enabled: true,
          },
        },
      },
      "shallow",
    );
  });

  it("repairs account projection with an explicit reason", async () => {
    await AccountActions.prototype.repairAccountProjection.call(
      {},
      {
        reason: "foreground-wake",
      },
    );

    expect(refreshAccountSnapshotMock).toHaveBeenCalledWith("foreground-wake");
  });
});

describe("acknowledged appearance writes", () => {
  function fixture() {
    const state = {
      account_id: "alice",
      user_type: "signed_in",
      other_settings: { appearance_theme: "dark", locale: "fr" },
    };
    (webapp_client as any).account_id = state.account_id;
    const set = jest.fn(async ({ other_settings }) => {
      state.other_settings = other_settings;
    });
    const actions = Object.create(AccountActions.prototype);
    actions.redux = {
      getStore: () => ({
        get: (name: string) =>
          name === "other_settings"
            ? {
                get: (key: string) => state.other_settings[key],
                toJS: () => state.other_settings,
              }
            : state[name],
      }),
      getTable: () => ({ set }),
    };
    const query = webapp_client.async_query as jest.Mock;
    query.mockImplementation(async ({ query }) => {
      state.other_settings = {
        ...state.other_settings,
        ...query.accounts.other_settings,
      };
    });
    return { actions, state, set, query };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    refreshAccountSnapshotMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    (webapp_client as any).account_id = undefined;
  });

  it("submits an explicit old-baseline choice without using the stale table", async () => {
    const { actions, query, set, state } = fixture();
    // The server/feed is Dark, even if the snapshot-only table still knows Light.
    // A table write equal to that stale baseline is a no-op, not a server write.
    set.mockImplementation(async () => {});
    refreshAccountSnapshotMock.mockImplementation(async () => {
      state.other_settings.appearance_theme = "light";
    });
    const save = actions.set_other_settings_and_wait(
      "appearance_theme",
      "light",
    );
    await jest.advanceTimersByTimeAsync(2500);
    await save;
    expect(query).toHaveBeenCalledWith({
      query: {
        accounts: {
          account_id: "alice",
          other_settings: { appearance_theme: "light" },
        },
      },
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();
    expect(state.other_settings.appearance_theme).toBe("light");
    expect(state.other_settings.locale).toBe("fr");
    expect(refreshAccountSnapshotMock).not.toHaveBeenCalled();
  });

  it("still writes when the current projection already matches the choice", async () => {
    const { actions, query } = fixture();
    await actions.set_other_settings_and_wait("appearance_theme", "dark");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("repairs a missing realtime acknowledgment through the existing snapshot path", async () => {
    const { actions, state, query } = fixture();
    query.mockResolvedValue(undefined);
    refreshAccountSnapshotMock.mockImplementation(async () => {
      state.other_settings.appearance_theme = "light";
    });
    const save = actions.set_other_settings_and_wait(
      "appearance_theme",
      "light",
    );
    await jest.advanceTimersByTimeAsync(2500);
    await save;
    expect(refreshAccountSnapshotMock).toHaveBeenCalledWith("write-ack");
  });

  it("rejects a failed query without repairing or optimistically changing the projection", async () => {
    const { actions, state, query } = fixture();
    const error = new Error("synthetic write failure");
    query.mockRejectedValue(error);
    await expect(
      actions.set_other_settings_and_wait("appearance_theme", "light"),
    ).rejects.toBe(error);
    expect(state.other_settings.appearance_theme).toBe("dark");
    expect(refreshAccountSnapshotMock).not.toHaveBeenCalled();
  });

  it("rejects a client/account mismatch before sending a write", async () => {
    const { actions, query } = fixture();
    (webapp_client as any).account_id = "bob";
    await expect(
      actions.set_other_settings_and_wait("appearance_theme", "light"),
    ).rejects.toThrow("Account changed");
    expect(query).not.toHaveBeenCalled();
    expect(refreshAccountSnapshotMock).not.toHaveBeenCalled();
  });

  it("does not accept or repair a different account after an in-flight write", async () => {
    const { actions, state, query } = fixture();
    query.mockImplementation(async () => {
      state.account_id = "bob";
      (webapp_client as any).account_id = "bob";
    });
    await expect(
      actions.set_other_settings_and_wait("appearance_theme", "light"),
    ).rejects.toThrow("Account changed");
    expect(refreshAccountSnapshotMock).not.toHaveBeenCalled();
  });

  it.each(["switch", "sign-out"])(
    "stops acknowledgment polling after %s without repairing the next session",
    async (transition) => {
      const { actions, state, query } = fixture();
      query.mockResolvedValue(undefined);
      const save = actions.set_other_settings_and_wait(
        "appearance_theme",
        "light",
      );
      const outcome = save.then(
        () => undefined,
        (error) => error,
      );
      await jest.advanceTimersByTimeAsync(100);
      if (transition === "switch") {
        state.account_id = "bob";
        (webapp_client as any).account_id = "bob";
      } else {
        state.user_type = "public";
      }
      await jest.advanceTimersByTimeAsync(2500);
      expect(await outcome).toMatchObject({
        message: expect.stringContaining("Account changed"),
      });
      expect(refreshAccountSnapshotMock).not.toHaveBeenCalled();
    },
  );

  it("rejects a successful write when snapshot repair never confirms it", async () => {
    const { actions, state, query } = fixture();
    query.mockResolvedValue(undefined);
    const save = actions.set_other_settings_and_wait(
      "appearance_theme",
      "light",
    );
    const outcome = save.then(
      () => undefined,
      (error) => error,
    );
    await jest.advanceTimersByTimeAsync(5000);
    expect(await outcome).toMatchObject({
      message: expect.stringContaining("projection did not converge"),
    });
    expect(refreshAccountSnapshotMock).toHaveBeenCalledTimes(1);
    expect(state.other_settings.appearance_theme).toBe("dark");
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
