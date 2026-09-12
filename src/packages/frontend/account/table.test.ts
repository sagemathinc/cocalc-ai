/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { AccountTable, applyAccountPatch } from "./table";

function accountProjection() {
  let state: Record<string, any> = {};
  const redux = {
    getActions: () => ({
      setState: (patch) => (state = { ...state, ...patch }),
    }),
    getStore: () => ({
      get: (name: string) =>
        name === "other_settings"
          ? { toJS: () => state.other_settings ?? {} }
          : state[name],
      emit: jest.fn(),
    }),
  };
  // Exercise the snapshot callback without creating a network-backed Table.
  const table = Object.create(AccountTable.prototype);
  table.redux = redux;
  table.first_set = true;
  return {
    state: () => state,
    snapshot: (other_settings, extra = {}) =>
      table._change({
        get_one: () => ({
          toJS: () => ({ account_id: "alice", other_settings, ...extra }),
        }),
      }),
    realtime: (other_settings) =>
      applyAccountPatch({ redux, patch: { other_settings } }),
  };
}

describe("AccountTable", () => {
  it("requests readable account bootstrap fields", () => {
    const query = AccountTable.prototype.query.call({});
    expect(query.accounts[0]).toMatchObject({
      account_id: null,
      home_bay_id: null,
    });
    expect(query.accounts[0]).not.toHaveProperty("sign_up_usage_intent");
  });

  it("uses snapshot-only account bootstrap without a changefeed", () => {
    expect(AccountTable.prototype.no_changefeed.call({})).toBe(true);
  });

  it.each([
    ["light", "dark"],
    ["dark", "light"],
  ])(
    "does not replay stale %s over realtime %s on a local edit",
    (stale, current) => {
      const projection = accountProjection();
      projection.snapshot({ appearance_theme: stale, dark_mode: false });
      projection.realtime({ appearance_theme: current });
      projection.snapshot(
        { appearance_theme: stale, dark_mode: false },
        { font_size: 16 },
      );
      expect(projection.state()).toMatchObject({
        font_size: 16,
        other_settings: { appearance_theme: current },
      });
      projection.snapshot({
        appearance_theme: stale,
        dark_mode: false,
        locale: "fr",
      });
      expect(projection.state().other_settings).toMatchObject({
        appearance_theme: current,
        locale: "fr",
      });
    },
  );

  it("forwards explicit legacy migration even when the effective theme is unchanged", () => {
    const projection = accountProjection();
    projection.snapshot({ dark_mode: false });
    projection.snapshot({ dark_mode: false, appearance_theme: "light" });
    expect(projection.state().other_settings.appearance_theme).toBe("light");
  });

  it("preserves appearance when a local settings row intentionally omits it", () => {
    const projection = accountProjection();
    projection.snapshot({
      appearance_theme: "light",
      dark_mode: false,
      launcher: { quickCreate: ["chat", "ipynb"] },
    });
    projection.realtime({ appearance_theme: "dark", dark_mode: true });
    projection.snapshot({ locale: "en", launcher: { quickCreate: ["py"] } });
    expect(projection.state().other_settings).toEqual({
      appearance_theme: "dark",
      dark_mode: true,
      locale: "en",
      launcher: { quickCreate: ["py"] },
    });
    projection.snapshot({ locale: "de", launcher: { quickCreate: [] } });
    expect(projection.state().other_settings).toEqual({
      appearance_theme: "dark",
      dark_mode: true,
      locale: "de",
      launcher: { quickCreate: [] },
    });
  });

  it("does not forward an unchanged explicit theme with a changed legacy key", () => {
    const projection = accountProjection();
    projection.snapshot({ appearance_theme: "light", dark_mode: false });
    projection.realtime({ appearance_theme: "dark" });
    projection.snapshot({ appearance_theme: "light", dark_mode: true });
    expect(projection.state().other_settings).toMatchObject({
      appearance_theme: "dark",
      dark_mode: true,
    });
  });

  it("forwards genuine raw preference changes, including null and System", () => {
    const projection = accountProjection();
    projection.snapshot({ appearance_theme: "light", dark_mode: false });
    projection.snapshot({ appearance_theme: "system", dark_mode: false });
    expect(projection.state().other_settings.appearance_theme).toBe("system");
    projection.snapshot({ appearance_theme: null, dark_mode: true });
    expect(projection.state().other_settings).toMatchObject({
      appearance_theme: null,
      dark_mode: true,
    });
  });

  it("accepts fresh realtime preferences after ignoring an old snapshot replay", () => {
    const projection = accountProjection();
    projection.snapshot({ appearance_theme: "light" });
    projection.realtime({ appearance_theme: "dark" });
    projection.snapshot({ appearance_theme: "light" });
    expect(projection.state().other_settings.appearance_theme).toBe("dark");
    projection.realtime({ appearance_theme: "system" });
    expect(projection.state().other_settings.appearance_theme).toBe("system");
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
