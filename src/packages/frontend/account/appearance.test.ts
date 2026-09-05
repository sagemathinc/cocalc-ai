/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { EventEmitter } from "events";
import { fromJS } from "immutable";
import { createAppearanceStore } from "@cocalc/util/appearance-store";
import { initAccountAppearance } from "./appearance";

test("ignores pre-auth defaults, handles Immutable settings, and uses acknowledged account saves", async () => {
  const state = {
    user_type: "signing_in",
    is_ready: false,
    account_id: "alice",
    other_settings: fromJS({ dark_mode: false, locale: "fr" }),
  };
  const account = Object.assign(new EventEmitter(), {
    get: (key: string) => state[key],
  });
  const appearance = createAppearanceStore({ systemDark: true });
  const actions = {
    set_other_settings_and_wait: jest.fn(async (key, value) => {
      state.other_settings = state.other_settings.set(key, value);
      account.emit("change");
    }),
  };
  const dispose = initAccountAppearance(account as any, actions, appearance);
  expect(appearance.getSnapshot().preference).toBe("system");
  state.is_ready = true;
  state.user_type = "signed_in";
  account.emit("change");
  expect(appearance.getSnapshot().preference).toBe("light");
  await appearance.choose("dark");
  expect(actions.set_other_settings_and_wait).toHaveBeenCalledWith(
    "appearance_theme",
    "dark",
  );
  expect(state.other_settings.get("locale")).toBe("fr");
  expect(appearance.getSnapshot().preference).toBe("dark");
  state.user_type = "public";
  account.emit("change");
  expect(appearance.getSnapshot().preference).toBe("system");
  dispose();
  expect(account.listenerCount("change")).toBe(0);
});

test("plain settings work and an account switch cancels an unstarted save", async () => {
  const state = {
    user_type: "signed_in",
    is_ready: true,
    account_id: "alice",
    other_settings: { appearance_theme: "system" },
  };
  const account = Object.assign(new EventEmitter(), {
    get: (key: string) => state[key],
  });
  const actions = { set_other_settings_and_wait: jest.fn(async () => {}) };
  const appearance = createAppearanceStore();
  const dispose = initAccountAppearance(account as any, actions, appearance);
  const save = appearance.choose("dark");
  state.account_id = "bob";
  account.emit("change");
  await save;
  expect(actions.set_other_settings_and_wait).not.toHaveBeenCalled();
  expect(appearance.getSnapshot().preference).toBe("system");
  dispose();
});
