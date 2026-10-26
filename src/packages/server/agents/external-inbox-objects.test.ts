/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const storageConfig = jest.fn();
const r2Auth = jest.fn();

jest.mock("@cocalc/server/blobs/config", () => ({
  resolveBlobStorageConfig: (...args: unknown[]) => storageConfig(...args),
  resolveBlobR2Auth: (...args: unknown[]) => r2Auth(...args),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-7",
}));

import {
  EXTERNAL_INBOX_OBJECT_PREFIX,
  externalInboxObjectKey,
  externalInboxObjects,
  removeExpiredExternalInboxObjects,
  setExternalInboxObjectsForTesting,
} from "./external-inbox-objects";

const auth = {
  endpoint: "https://r2.example.com",
  accessKey: "a",
  secretKey: "s",
  bucket: "blobs",
};

afterEach(() => setExternalInboxObjectsForTesting(undefined));

test("a file's key begins with its bay, then the day after its message expires", () => {
  expect(
    externalInboxObjectKey({
      account_id: "acct",
      attempt_id: "attempt",
      idx: 2,
      sha256: "ab",
      expires_at: Date.parse("2026-11-02T23:30:00Z"),
    }),
  ).toBe(`${EXTERNAL_INBOX_OBJECT_PREFIX}bay-7/2026-11-03/acct/attempt/2-ab`);
});

test("cleanup lists only this bay's oldest keys, a bounded batch, and removes past days", async () => {
  const prefix = `${EXTERNAL_INBOX_OBJECT_PREFIX}bay-7/`;
  const keys = [
    `${prefix}2026-10-24/a/b/0-x`,
    `${prefix}2026-10-25/a/c/0-y`,
    `${prefix}2026-10-26/a/d/0-z`,
    `${prefix}2026-11-02/a/e/0-w`,
  ];
  const removed: string[] = [];
  const list = jest.fn(async (_prefix: string, limit: number) =>
    keys.slice(0, limit),
  );
  setExternalInboxObjectsForTesting({
    put: jest.fn(),
    get: jest.fn(),
    list,
    delete: jest.fn(async (gone: string[]) => {
      removed.push(...gone);
      for (const key of gone) keys.splice(keys.indexOf(key), 1);
    }),
  });
  const now = Date.parse("2026-10-26T01:00:00Z");
  // A full batch: more may be left.
  expect(await removeExpiredExternalInboxObjects({ now, limit: 1 })).toBe(1);
  expect(list).toHaveBeenLastCalledWith(prefix, 1);
  // The next one ends at today's objects.
  expect(await removeExpiredExternalInboxObjects({ now, limit: 3 })).toBe(1);
  expect(removed).toEqual([
    `${prefix}2026-10-24/a/b/0-x`,
    `${prefix}2026-10-25/a/c/0-y`,
  ]);
  expect(await removeExpiredExternalInboxObjects({ now, limit: 3 })).toBe(0);
});

test("without R2 there is nothing to clean up", async () => {
  setExternalInboxObjectsForTesting(null);
  expect(await removeExpiredExternalInboxObjects({ limit: 10 })).toBe(0);
});

test("new files go to R2 only while it is the backend; stored ones stay reachable", async () => {
  r2Auth.mockResolvedValue(auth);
  // The backend was switched to Postgres, with the R2 credentials still set.
  storageConfig.mockResolvedValue({
    backend: "postgres",
    activeBackend: "postgres",
  });
  expect(await externalInboxObjects("write")).toBeUndefined();
  expect(await externalInboxObjects("read")).toBeDefined();
  storageConfig.mockResolvedValue({
    backend: "r2",
    activeBackend: "r2",
    r2: { auth },
  });
  expect(await externalInboxObjects("write")).toBeDefined();
  // No credentials at all: nothing to read from.
  r2Auth.mockResolvedValue(undefined);
  expect(await externalInboxObjects("read")).toBeUndefined();
});
