/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { AccountActions } from "./actions";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import api from "@cocalc/frontend/client/api";
import { refreshAccountSnapshot } from "./table";
import { EventEmitter } from "events";
import { fromJS } from "immutable";
import { once } from "@cocalc/util/async-utils";
import { synctable_no_changefeed } from "@cocalc/sync/table/synctable-no-changefeed";

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
  webapp_client: Object.assign(new (require("events").EventEmitter)(), {
    account_id: undefined,
    async_query: jest.fn(),
    sync_client: { synctable_no_changefeed: jest.fn() },
    conat_client: {
      hub: {
        system: {
          getAccountBay: jest.fn(),
        },
      },
    },
  }),
}));

describe("AccountActions.set_other_settings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (webapp_client as any).account_id = "alice";
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
            : name === "account_id"
              ? "alice"
              : name === "user_type"
                ? "signed_in"
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
            : name === "account_id"
              ? "alice"
              : name === "user_type"
                ? "signed_in"
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
      state.other_settings = { ...state.other_settings, ...other_settings };
    });
    const actions = Object.create(AccountActions.prototype);
    const account = Object.assign(new EventEmitter(), {
      get: (name: string) =>
        name === "other_settings"
          ? {
              get: (key: string) => state.other_settings[key],
              toJS: () => state.other_settings,
            }
          : state[name],
    });
    actions.redux = {
      getStore: () => account,
      getTable: () => ({ set }),
    };
    const query = webapp_client.async_query as jest.Mock;
    query.mockImplementation(async ({ query }) => {
      state.other_settings = {
        ...state.other_settings,
        ...query.accounts.other_settings,
      };
    });
    return { actions, state, set, query, account };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    refreshAccountSnapshotMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    (webapp_client as any).account_id = undefined;
    webapp_client.removeAllListeners();
  });

  it.each(["signing_in", "public"])(
    "waits for same-account bootstrap from %s before saving URL locale",
    async (initialUserType) => {
      // account/init.ts starts with either of these values, and app/render.tsx
      // can request ?lang= persistence once the account id arrives first.
      const { actions, state, account, set, query } = fixture();
      state.user_type = initialUserType;
      const result = actions.set_other_settings_and_wait("locale", "en").then(
        () => "saved",
        (error) => error,
      );
      await jest.advanceTimersByTimeAsync(1000);
      expect(set).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(refreshAccountSnapshotMock).not.toHaveBeenCalled();
      state.user_type = "signed_in";
      account.emit("change");
      await expect(result).resolves.toBe("saved");
      expect(set).toHaveBeenCalledTimes(1);
      expect(set.mock.calls[0][0].other_settings).toEqual({ locale: "en" });
      expect(account.listenerCount("change")).toBe(0);
      expect(webapp_client.listenerCount("signed_out")).toBe(0);
      expect(webapp_client.listenerCount("remember_me_failed")).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it.each(["switch", "signed_out", "remember_me_failed", "public"])(
    "abandons a bootstrap settings write on %s without replaying it",
    async (transition) => {
      const { actions, state, account, set, query } = fixture();
      state.user_type = "signing_in";
      let settled = false;
      const result = actions
        .set_other_settings_and_wait("locale", "en")
        .catch((error) => error)
        .finally(() => {
          settled = true;
        });
      await jest.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);
      if (transition === "switch") {
        state.account_id = "bob";
        (webapp_client as any).account_id = "bob";
        account.emit("change");
      } else if (transition === "public") {
        state.user_type = "public";
        account.emit("change");
      } else {
        webapp_client.emit(transition);
      }
      // Even a subsequent successful sign-in must not replay the old request.
      state.account_id = "alice";
      (webapp_client as any).account_id = "alice";
      state.user_type = "signed_in";
      account.emit("change");
      expect(await result).toMatchObject({
        message: expect.stringContaining("Account changed"),
      });
      expect(set).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(refreshAccountSnapshotMock).not.toHaveBeenCalled();
      expect(account.listenerCount("change")).toBe(0);
      expect(webapp_client.listenerCount("signed_out")).toBe(0);
      expect(webapp_client.listenerCount("remember_me_failed")).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it("times out an unfinished account bootstrap without sending or repairing", async () => {
    const { actions, state, account, set, query } = fixture();
    state.user_type = "signing_in";
    let settled = false;
    const result = actions
      .set_other_settings_and_wait("locale", "en")
      .catch((error) => error)
      .finally(() => {
        settled = true;
      });
    await jest.advanceTimersByTimeAsync(59_999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({
      message: expect.stringContaining("Account sign-in timed out"),
    });
    state.user_type = "signed_in";
    account.emit("change");
    expect(set).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(refreshAccountSnapshotMock).not.toHaveBeenCalled();
    expect(account.listenerCount("change")).toBe(0);
    expect(webapp_client.listenerCount("signed_out")).toBe(0);
    expect(webapp_client.listenerCount("remember_me_failed")).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
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

  it.each([
    { appearance_theme: "dark", locale: "en" },
    { dark_mode: false, locale: "en" },
  ])(
    "submits an explicit mixed appearance request in one query: %p",
    async (values) => {
      const { actions, query, set } = fixture();
      await actions.set_other_settings_many_and_wait(values);
      expect(query).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledWith({
        query: { accounts: { account_id: "alice", other_settings: values } },
      });
      expect(set).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid mixed preference before writing any setting", async () => {
    const { actions, query, set } = fixture();
    await expect(
      actions.set_other_settings_many_and_wait({
        appearance_theme: "invalid",
        locale: "en",
      }),
    ).rejects.toThrow("Invalid appearance preference");
    expect(query).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("does not resend a rejected optimistic preference with a later setting", async () => {
    const { actions, query, set, state } = fixture();
    // Simulate the local optimistic value remaining after the explicit save fails.
    state.other_settings.appearance_theme = "light";
    query.mockRejectedValueOnce(new Error("synthetic write failure"));
    await expect(
      actions.set_other_settings_and_wait("appearance_theme", "light"),
    ).rejects.toThrow("synthetic write failure");
    await actions.set_other_settings_and_wait("locale", "en");
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][0].other_settings).toEqual({ locale: "en" });
    expect(query).toHaveBeenCalledTimes(1);
    expect(refreshAccountSnapshotMock).not.toHaveBeenCalled();
  });

  it("rejects an unrelated setting when the client has changed accounts", async () => {
    const { actions, query, set } = fixture();
    (webapp_client as any).account_id = "bob";
    await expect(
      actions.set_other_settings_and_wait("locale", "en"),
    ).rejects.toThrow("Account changed");
    expect(query).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("does not acknowledge an unrelated write after an account change", async () => {
    const { actions, state, set } = fixture();
    set.mockImplementation(async ({ other_settings }) => {
      state.other_settings = { ...state.other_settings, ...other_settings };
      state.account_id = "bob";
      (webapp_client as any).account_id = "bob";
    });
    await expect(
      actions.set_other_settings_and_wait("locale", "en"),
    ).rejects.toThrow("Account changed");
    expect(refreshAccountSnapshotMock).not.toHaveBeenCalled();
  });

  it.each([{ locale: "en" }, { appearance_theme: "light", locale: "en" }])(
    "rejects an account change during snapshot repair for %p",
    async (values) => {
      const { actions, state, set, query } = fixture();
      set.mockImplementation(async () => {});
      query.mockResolvedValue(undefined);
      refreshAccountSnapshotMock.mockImplementation(async () => {
        state.account_id = "bob";
        (webapp_client as any).account_id = "bob";
      });
      const result = actions
        .set_other_settings_many_and_wait(values)
        .catch((error) => error);
      await jest.advanceTimersByTimeAsync(2500);
      expect(await result).toMatchObject({
        message: expect.stringContaining("Account changed"),
      });
      expect(refreshAccountSnapshotMock).toHaveBeenCalledTimes(1);
    },
  );

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

describe("account settings outgoing snapshot-table writes", () => {
  // Use the actual AccountActions -> AccountTable -> SyncTable set/save chain.
  // Only the query transport is synthetic; these assertions concern emitted
  // patches and local projection, not PostgreSQL nested replacement semantics.
  async function fixture() {
    const { AccountTable, applyAccountPatch } = jest.requireActual("./table");
    const accountId = "11111111-1111-4111-8111-111111111111";
    let state = fromJS({ account_id: accountId, user_type: "signed_in" });
    const store = Object.assign(new EventEmitter(), {
      get: (name: string) => state.get(name),
      getIn: (path: string[]) => state.getIn(path),
    });
    const actions = Object.create(AccountActions.prototype);
    actions.setState = (patch) => {
      state = state.merge(fromJS(patch));
      store.emit("change");
    };
    let table;
    const redux = {
      getActions: () => actions,
      getStore: () => store,
      getTable: () => table,
    };
    actions.redux = redux;
    (webapp_client as any).account_id = accountId;
    const writes: any[] = [];
    const client = Object.assign(new EventEmitter(), {
      is_project: () => false,
      is_browser: () => true,
      is_connected: () => true,
      is_signed_in: () => true,
      server_time: () => new Date(),
      dbg: () => () => {},
      touch_project: async () => {},
      alert_message: () => {},
      is_deleted: () => undefined,
      query_cancel: () => {},
      query: (opts) => {
        if (Array.isArray(opts.query)) {
          writes.push(...JSON.parse(JSON.stringify(opts.query)));
          opts.cb(undefined, {});
        } else {
          opts.cb(undefined, {
            query: {
              accounts: [
                {
                  account_id: accountId,
                  other_settings: {
                    appearance_theme: "light",
                    dark_mode: false,
                    locale: "fr",
                    newsletter: false,
                    launcher: { quickCreate: ["chat", "ipynb"] },
                  },
                },
              ],
            },
          });
        }
      },
    });
    (
      webapp_client.sync_client.synctable_no_changefeed as jest.Mock
    ).mockImplementation((query, options) =>
      synctable_no_changefeed(query, options, client as any, 0),
    );
    table = new AccountTable("account", redux);
    if (!table._table.is_ready()) await once(table._table, "connected");
    const realtime = (other_settings) =>
      applyAccountPatch({
        redux,
        patch: { other_settings },
        appearance_snapshot: true,
      });
    const query = webapp_client.async_query as jest.Mock;
    query.mockImplementation(async ({ query }) => {
      writes.push(JSON.parse(JSON.stringify(query)));
      realtime(query.accounts.other_settings);
    });
    return {
      actions,
      writes,
      query,
      realtime,
      settings: () => state.get("other_settings").toJS(),
      close: async () => {
        const closed = once(table._table, "closed");
        table.close();
        await closed;
      },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    refreshAccountSnapshotMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    (webapp_client as any).account_id = undefined;
  });

  it.each(["theme-first", "setting-first"])(
    "omits implicit appearance keys from the real outgoing patch (%s)",
    async (order) => {
      const f = await fixture();
      try {
        f.realtime({ appearance_theme: "dark", dark_mode: true });
        const theme = () =>
          f.actions.set_other_settings_and_wait("appearance_theme", "system");
        const locale = () =>
          f.actions.set_other_settings_and_wait("locale", "en");
        await Promise.all(
          order === "theme-first" ? [theme(), locale()] : [locale(), theme()],
        );
        const settingsWrite = f.writes.find(
          (q) => q.accounts.other_settings?.locale === "en",
        );
        expect(settingsWrite.accounts.other_settings).not.toHaveProperty(
          "appearance_theme",
        );
        expect(settingsWrite.accounts.other_settings).not.toHaveProperty(
          "dark_mode",
        );
        expect(
          f.writes.filter((q) =>
            Object.hasOwn(q.accounts.other_settings ?? {}, "appearance_theme"),
          ),
        ).toEqual([
          {
            accounts: {
              account_id: "11111111-1111-4111-8111-111111111111",
              other_settings: { appearance_theme: "system" },
            },
          },
        ]);
        expect(f.settings()).toMatchObject({
          appearance_theme: "system",
          locale: "en",
        });
      } finally {
        await f.close();
      }
    },
  );

  it("preserves coalesced disjoint settings and shallow local nested replacement", async () => {
    const f = await fixture();
    try {
      f.realtime({ appearance_theme: "dark", dark_mode: true });
      const first = f.actions.set_other_settings_and_wait("locale", "en");
      const second = f.actions.set_other_settings_many_and_wait({
        newsletter: true,
        launcher: { quickCreate: ["py"] },
      });
      await Promise.all([first, second]);
      expect(f.writes).toHaveLength(1);
      const combined = Object.assign(
        {},
        ...f.writes.map((q) => q.accounts.other_settings),
      );
      expect(combined).toMatchObject({
        locale: "en",
        newsletter: true,
        launcher: { quickCreate: ["py"] },
      });
      for (const write of f.writes) {
        expect(write.accounts.other_settings).not.toHaveProperty(
          "appearance_theme",
        );
        expect(write.accounts.other_settings).not.toHaveProperty("dark_mode");
      }
      expect(f.settings()).toMatchObject({
        appearance_theme: "dark",
        locale: "en",
        newsletter: true,
        launcher: { quickCreate: ["py"] },
      });
    } finally {
      await f.close();
    }
  });

  it("does not put a failed optimistic choice into a later SyncTable query", async () => {
    const f = await fixture();
    try {
      f.realtime({ appearance_theme: "dark", dark_mode: true });
      f.query.mockRejectedValueOnce(new Error("synthetic write failure"));
      await expect(
        f.actions.set_other_settings_and_wait("appearance_theme", "dark"),
      ).rejects.toThrow("synthetic write failure");
      await f.actions.set_other_settings_and_wait("locale", "en");
      expect(f.writes).toHaveLength(1);
      expect(f.writes[0].accounts.other_settings).not.toHaveProperty(
        "appearance_theme",
      );
      expect(f.writes[0].accounts.other_settings).not.toHaveProperty(
        "dark_mode",
      );
      expect(f.settings()).toMatchObject({
        appearance_theme: "dark",
        locale: "en",
      });
    } finally {
      await f.close();
    }
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
