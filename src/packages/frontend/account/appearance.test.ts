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
import {
  ACCOUNT_APPEARANCE_SNAPSHOT,
  initAccountAppearance,
} from "./appearance";
import { applyAccountPatch } from "./table";

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
  account.emit(ACCOUNT_APPEARANCE_SNAPSHOT, "alice");
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
  account.emit(ACCOUNT_APPEARANCE_SNAPSHOT, "alice");
  appearance.setSystemDark(false);
  expect(appearance.getSnapshot()).toMatchObject({
    preference: "dark",
    resolved: "dark",
    saving: false,
    saveError: expect.any(String),
  });
  dispose();
});

test.each([
  ["light", "dark", false],
  ["dark", "light", false],
  ["light", "dark", true],
  ["dark", "light", true],
] as const)(
  "accepts an authoritative %s snapshot after cached %s, including replacement=%s",
  (serverPreference, cachedPreference, first_set) => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const state = {
      account_id: "alice",
      user_type: "signed_in",
      is_ready: true,
      other_settings: fromJS({ appearance_theme: serverPreference }),
    };
    const account = Object.assign(new EventEmitter(), {
      get: (key: string) => state[key],
    });
    const redux = {
      getStore: () => account,
      getActions: () => ({
        setState: (patch) => {
          const before = fromJS(state);
          Object.assign(state, patch);
          if (patch.other_settings != null) {
            state.other_settings = fromJS(patch.other_settings);
          }
          if (!before.equals(fromJS(state)))
            account.emit("change", fromJS(state));
        },
      }),
    };
    const actions = { set_other_settings_and_wait: jest.fn(async () => {}) };
    const appearance = createAppearanceStore({ storage });
    const dispose = initAccountAppearance(account as any, actions, appearance);
    storage.setItem(
      APPEARANCE_ACCOUNT_STORAGE_KEY,
      serializeAppearance(cachedPreference, "alice"),
    );
    appearance.receiveStorageChange(APPEARANCE_ACCOUNT_STORAGE_KEY);
    account.emit(ACCOUNT_APPEARANCE_SNAPSHOT, "bob");
    expect(appearance.getSnapshot().preference).toBe(cachedPreference);
    // A newer account event alone is not an appearance observation.
    applyAccountPatch({
      redux,
      patch: { font_size: 16 },
      appearance_snapshot: true,
    });
    expect(appearance.getSnapshot().preference).toBe(cachedPreference);
    applyAccountPatch({
      redux,
      patch: { other_settings: { locale: "fr" } },
      appearance_snapshot: true,
    });
    expect(appearance.getSnapshot().preference).toBe(cachedPreference);
    // This server snapshot genuinely says the same value last seen by Redux.
    applyAccountPatch({
      redux,
      patch: {
        account_id: "alice",
        other_settings: { appearance_theme: serverPreference },
      },
      first_set,
      appearance_snapshot: true,
    });
    expect(appearance.getSnapshot().preference).toBe(serverPreference);
    expect(
      JSON.parse(storage.getItem(APPEARANCE_ACCOUNT_STORAGE_KEY)!),
    ).toMatchObject({
      account_id: "alice",
      preference: serverPreference,
    });
    // Omitting settings is not a reset; explicit null is an authoritative reset.
    storage.setItem(
      APPEARANCE_ACCOUNT_STORAGE_KEY,
      serializeAppearance("dark", "alice"),
    );
    appearance.receiveStorageChange(APPEARANCE_ACCOUNT_STORAGE_KEY);
    applyAccountPatch({ redux, patch: {}, appearance_snapshot: true });
    expect(appearance.getSnapshot().preference).toBe("dark");
    applyAccountPatch({
      redux,
      patch: { other_settings: null },
      appearance_snapshot: true,
    });
    expect(appearance.getSnapshot().preference).toBe("light");
    expect(actions.set_other_settings_and_wait).not.toHaveBeenCalled();
    dispose();
    expect(account.listenerCount(ACCOUNT_APPEARANCE_SNAPSHOT)).toBe(0);
  },
);
