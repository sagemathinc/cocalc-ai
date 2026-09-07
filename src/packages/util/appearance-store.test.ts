/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  APPEARANCE_ACCOUNT_STORAGE_KEY,
  APPEARANCE_STORAGE_KEY,
  serializeAppearance,
} from "./appearance";
import { createAppearanceStore } from "./appearance-store";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: jest.fn((key: string, value: string) => {
      data.set(key, value);
    }),
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("anonymous choices apply immediately, persist explicitly, and never need an account", async () => {
  const storage = memoryStorage();
  const store = createAppearanceStore({ storage, systemDark: true });
  expect(store.getSnapshot()).toMatchObject({
    preference: "system",
    resolved: "dark",
    saving: false,
  });
  const unsubscribe = store.subscribe(jest.fn());
  const saved = store.choose("light");
  expect(store.getSnapshot().resolved).toBe("light");
  await saved;
  await store.choose("system");
  expect(storage.getItem(APPEARANCE_STORAGE_KEY)).toBe(
    serializeAppearance("system"),
  );
  unsubscribe();
});

test("OS updates do not save, and explicit choices ignore them", async () => {
  const storage = memoryStorage();
  const store = createAppearanceStore({ storage });
  store.setSystemDark(true);
  expect(store.getSnapshot().resolved).toBe("dark");
  expect(storage.setItem).not.toHaveBeenCalled();
  await store.choose("light");
  const changes = jest.fn();
  store.subscribe(changes);
  store.setSystemDark(false);
  store.setSystemDark(true);
  expect(changes).not.toHaveBeenCalled();
  expect(storage.setItem).toHaveBeenCalledTimes(1);
});

test("rapid account choices serialize writes and cannot finish out of order", async () => {
  const first = deferred();
  const save = jest
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue(undefined);
  const store = createAppearanceStore();
  store.receiveAccount("alice", "light", save);
  const old = store.choose("dark");
  await Promise.resolve();
  const newer = store.choose("system");
  expect(store.getSnapshot()).toMatchObject({
    preference: "system",
    saving: true,
  });
  store.receiveAccount("alice", "dark", save);
  expect(store.getSnapshot().preference).toBe("system");
  expect(save.mock.calls).toEqual([["dark"]]);
  first.resolve();
  await old;
  await newer;
  expect(save.mock.calls).toEqual([["dark"], ["system"]]);
  expect(store.getSnapshot()).toMatchObject({
    preference: "system",
    saving: false,
  });
});

test("obsolete queued choices are skipped", async () => {
  const save = jest.fn().mockResolvedValue(undefined);
  const store = createAppearanceStore();
  store.receiveAccount("alice", "light", save);
  await Promise.all([
    store.choose("dark"),
    store.choose("light"),
    store.choose("system"),
  ]);
  expect(save.mock.calls).toEqual([["system"]]);
});

test("save errors stay visible and preserve the local selection until retry", async () => {
  const save = jest
    .fn()
    .mockRejectedValueOnce(Error("offline"))
    .mockResolvedValue(undefined);
  const store = createAppearanceStore();
  store.receiveAccount("alice", "light", save);
  await store.choose("dark");
  expect(store.getSnapshot().saveError).toContain("could not be saved");
  store.receiveAccount("alice", "light", save);
  expect(store.getSnapshot().preference).toBe("dark");
  await store.choose("dark");
  expect(store.getSnapshot()).toMatchObject({
    preference: "dark",
    saving: false,
    saveError: undefined,
  });
});

test("a later authoritative change after acknowledgement wins", async () => {
  const waiting = deferred();
  const save = () => waiting.promise;
  const store = createAppearanceStore();
  store.receiveAccount("alice", "light", save);
  const pending = store.choose("dark");
  await Promise.resolve();
  store.receiveAccount("alice", "dark", save);
  store.receiveAccount("alice", "system", save);
  waiting.resolve();
  await pending;
  expect(store.getSnapshot().preference).toBe("system");
});

test("logout restores the visitor choice and late save completions cannot change it", async () => {
  const storage = memoryStorage({
    [APPEARANCE_STORAGE_KEY]: serializeAppearance("system"),
  });
  const waiting = deferred();
  const store = createAppearanceStore({ storage, accountHint: "alice" });
  store.receiveAccount("alice", "light", () => waiting.promise);
  const saved = store.choose("dark");
  await Promise.resolve();
  store.receiveAccount(undefined);
  waiting.reject(Error("old account failed"));
  await saved;
  expect(store.getSnapshot()).toMatchObject({
    preference: "system",
    saving: false,
    saveError: undefined,
  });
  store.receiveStorageChange(APPEARANCE_ACCOUNT_STORAGE_KEY);
  expect(store.getSnapshot().preference).toBe("system");
});

test("switching accounts isolates queues and does not copy choices between accounts", async () => {
  const waiting = deferred();
  const saveBob = jest.fn().mockResolvedValue(undefined);
  const store = createAppearanceStore();
  store.receiveAccount("alice", "light", () => waiting.promise);
  const old = store.choose("dark");
  await Promise.resolve();
  store.receiveAccount("bob", "system", saveBob);
  await store.choose("light");
  waiting.resolve();
  await old;
  expect(saveBob).toHaveBeenCalledWith("light");
  expect(store.getSnapshot().preference).toBe("light");
});

test("a choice made during account hydration is not lost to an older snapshot", async () => {
  const save = jest.fn().mockResolvedValue(undefined);
  const store = createAppearanceStore({ accountHint: "alice" });
  await store.choose("dark");
  store.receiveAccount("alice", "light", save);
  await Promise.resolve();
  expect(save).toHaveBeenCalledWith("dark");
  expect(store.getSnapshot().preference).toBe("dark");
});

test("cross-tab changes do not echo writes or adopt another account's cache", () => {
  const storage = memoryStorage();
  const save = jest.fn();
  const store = createAppearanceStore({ storage });
  store.receiveAccount("alice", "dark", save);
  storage.setItem(
    APPEARANCE_ACCOUNT_STORAGE_KEY,
    serializeAppearance("light", "bob"),
  );
  store.receiveStorageChange(APPEARANCE_ACCOUNT_STORAGE_KEY);
  expect(store.getSnapshot().preference).toBe("dark");
  storage.setItem(
    APPEARANCE_ACCOUNT_STORAGE_KEY,
    serializeAppearance("system", "alice"),
  );
  storage.setItem.mockClear();
  store.receiveStorageChange(APPEARANCE_ACCOUNT_STORAGE_KEY);
  expect(store.getSnapshot().preference).toBe("system");
  expect(save).not.toHaveBeenCalled();
  expect(storage.setItem).not.toHaveBeenCalled();
});

test("account hint is discarded after a failed login", () => {
  const storage = memoryStorage({
    [APPEARANCE_ACCOUNT_STORAGE_KEY]: serializeAppearance("dark", "alice"),
  });
  const store = createAppearanceStore({ storage, accountHint: "alice" });
  expect(store.getSnapshot().preference).toBe("dark");
  store.receiveAccount(undefined);
  store.receiveStorageChange(APPEARANCE_ACCOUNT_STORAGE_KEY);
  expect(store.getSnapshot().preference).toBe("system");
});

test("in-memory controls work when local storage throws", async () => {
  const storage = {
    getItem: () => {
      throw Error("blocked");
    },
    setItem: () => {
      throw Error("blocked");
    },
  };
  const store = createAppearanceStore({ storage, legacy: "essential" });
  await store.choose("dark");
  expect(store.getSnapshot()).toMatchObject({
    preference: "dark",
    resolved: "dark",
    saveError: undefined,
  });
});
