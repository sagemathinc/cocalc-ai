/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { EventEmitter } from "events";
import { fromJS } from "immutable";
import {
  APPEARANCE_ACCOUNT_STORAGE_KEY,
  serializeAppearance,
} from "@cocalc/util/appearance";
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

test("an unrelated account event does not undo a cross-tab appearance choice", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const state = {
    user_type: "signed_in",
    is_ready: true,
    account_id: "alice",
    other_settings: fromJS({ appearance_theme: "light", locale: "en" }),
  };
  const account = Object.assign(new EventEmitter(), {
    get: (key: string) => state[key],
  });
  const appearance = createAppearanceStore({ storage });
  const actions = { set_other_settings_and_wait: jest.fn(async () => {}) };
  const dispose = initAccountAppearance(account as any, actions, appearance);

  storage.setItem(
    APPEARANCE_ACCOUNT_STORAGE_KEY,
    serializeAppearance("dark", "alice"),
  );
  appearance.receiveStorageChange(APPEARANCE_ACCOUNT_STORAGE_KEY);
  state.other_settings = state.other_settings.set("locale", "fr");
  account.emit("change");
  expect(appearance.getSnapshot().preference).toBe("dark");
  expect(actions.set_other_settings_and_wait).not.toHaveBeenCalled();

  // A genuinely changed account preference still wins, including System.
  state.other_settings = state.other_settings.set("appearance_theme", "dark");
  account.emit("change");
  state.other_settings = state.other_settings.set("appearance_theme", "light");
  account.emit("change");
  expect(appearance.getSnapshot().preference).toBe("light");
  state.other_settings = state.other_settings.set("appearance_theme", "system");
  account.emit("change");
  appearance.setSystemDark(true);
  expect(appearance.getSnapshot().resolved).toBe("dark");

  // Signing out and back into the same account must reset the observation.
  state.other_settings = state.other_settings.set("appearance_theme", "dark");
  account.emit("change");
  state.user_type = "public";
  account.emit("change");
  expect(appearance.getSnapshot().preference).toBe("system");
  state.user_type = "signed_in";
  account.emit("change");
  expect(appearance.getSnapshot().preference).toBe("dark");
  dispose();
});

test("unchanged pending acknowledgments still reconcile a later remote choice", async () => {
  const state = {
    user_type: "signed_in",
    is_ready: true,
    account_id: "alice",
    other_settings: { appearance_theme: "light" },
  };
  const account = Object.assign(new EventEmitter(), {
    get: (key: string) => state[key],
  });
  let finishWrite!: () => void;
  const actions = {
    set_other_settings_and_wait: jest.fn(
      () => new Promise<void>((resolve) => (finishWrite = resolve)),
    ),
  };
  const appearance = createAppearanceStore();
  const dispose = initAccountAppearance(account as any, actions, appearance);
  const save = appearance.choose("light");
  await Promise.resolve();
  account.emit("change");
  state.other_settings = { appearance_theme: "dark" };
  account.emit("change");
  expect(appearance.getSnapshot()).toMatchObject({
    preference: "light",
    saving: true,
  });
  finishWrite();
  await save;
  expect(appearance.getSnapshot()).toMatchObject({
    preference: "dark",
    saving: false,
  });
  dispose();
});

test("failed saves retain the explicit choice despite account and OS events", async () => {
  const state = {
    user_type: "signed_in",
    is_ready: true,
    account_id: "alice",
    other_settings: { appearance_theme: "light" },
  };
  const account = Object.assign(new EventEmitter(), {
    get: (key: string) => state[key],
  });
  const actions = {
    set_other_settings_and_wait: jest.fn(async () => {
      throw new Error("synthetic write failure");
    }),
  };
  const appearance = createAppearanceStore();
  const dispose = initAccountAppearance(account as any, actions, appearance);
  await appearance.choose("dark");
  account.emit("change");
  appearance.setSystemDark(false);
  expect(appearance.getSnapshot()).toMatchObject({
    preference: "dark",
    resolved: "dark",
    saving: false,
    saveError: expect.any(String),
  });
  dispose();
});
