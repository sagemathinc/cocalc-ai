/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  createBrowserAppearanceStore,
  getBrowserAppearanceStore,
} from "./appearance-browser";
import { APPEARANCE_STORAGE_KEY, serializeAppearance } from "./appearance";

test("browser adapter owns root appearance and disposes both subscriptions", async () => {
  const entries = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
  const root = {
    dataset: {} as Record<string, string>,
    style: { colorScheme: "" },
  };
  const media = {
    matches: false,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  };
  const browser = {
    localStorage,
    document: { cookie: "", documentElement: root },
    location: { pathname: "/" },
    matchMedia: () => media,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  };
  const { store, dispose } = createBrowserAppearanceStore(
    browser as unknown as Window,
  );
  expect(root.dataset.cocalcTheme).toBe("light");
  const onMedia = media.addEventListener.mock.calls[0][1];
  onMedia({ matches: true });
  expect(root.dataset.cocalcTheme).toBe("dark");
  await store.choose("light");
  expect(root.style.colorScheme).toBe("light");
  const onStorage = browser.addEventListener.mock.calls[0][1];
  entries.set(APPEARANCE_STORAGE_KEY, serializeAppearance("dark"));
  onStorage({ key: APPEARANCE_STORAGE_KEY, storageArea: {} });
  expect(root.dataset.cocalcTheme).toBe("light");
  onStorage({ key: APPEARANCE_STORAGE_KEY, storageArea: localStorage });
  expect(root.dataset.cocalcTheme).toBe("dark");
  dispose();
  expect(media.removeEventListener).toHaveBeenCalledWith("change", onMedia);
  expect(browser.removeEventListener).toHaveBeenCalledWith(
    "storage",
    onStorage,
  );
});

test("browser adapter tolerates unavailable APIs and restricted cookie/storage access", async () => {
  const root = { dataset: {}, style: {} };
  const browser = {
    get localStorage() {
      throw Error("blocked");
    },
    document: {
      get cookie() {
        throw Error("blocked");
      },
      documentElement: root,
    },
    location: { pathname: "/" },
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  };
  const { store, dispose } = createBrowserAppearanceStore(
    browser as unknown as Window,
  );
  await store.choose("dark");
  expect(root.dataset).toEqual({ cocalcTheme: "dark" });
  dispose();
});

test("server imports require no browser globals", () => {
  expect(getBrowserAppearanceStore().getSnapshot()).toMatchObject({
    preference: "system",
    resolved: "light",
  });
});
