/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  EXTERNAL_INBOX_OBJECT_PREFIX,
  externalInboxObjectKey,
  removeExpiredExternalInboxObjects,
  setExternalInboxObjectsForTesting,
} from "./external-inbox-objects";

afterEach(() => setExternalInboxObjectsForTesting(undefined));

test("a file's key begins with the day after its message expires", () => {
  expect(
    externalInboxObjectKey({
      account_id: "acct",
      attempt_id: "attempt",
      idx: 2,
      sha256: "ab",
      expires_at: Date.parse("2026-11-02T23:30:00Z"),
    }),
  ).toBe(`${EXTERNAL_INBOX_OBJECT_PREFIX}2026-11-03/acct/attempt/2-ab`);
});

test("cleanup removes every object of a past day, and nothing else", async () => {
  const keys = [
    `${EXTERNAL_INBOX_OBJECT_PREFIX}2026-10-24/a/b/0-x`,
    `${EXTERNAL_INBOX_OBJECT_PREFIX}2026-10-25/a/c/0-y`,
    `${EXTERNAL_INBOX_OBJECT_PREFIX}2026-10-26/a/d/0-z`,
    `${EXTERNAL_INBOX_OBJECT_PREFIX}2026-11-02/a/e/0-w`,
    `${EXTERNAL_INBOX_OBJECT_PREFIX}not-a-day/a/f/0-v`,
  ];
  const removed: string[] = [];
  const list = jest.fn(async () => keys);
  setExternalInboxObjectsForTesting({
    put: jest.fn(),
    get: jest.fn(),
    list,
    delete: jest.fn(async (gone: string[]) => {
      removed.push(...gone);
    }),
  });
  expect(
    await removeExpiredExternalInboxObjects(Date.parse("2026-10-26T01:00:00Z")),
  ).toBe(2);
  expect(list).toHaveBeenCalledWith(EXTERNAL_INBOX_OBJECT_PREFIX);
  expect(removed).toEqual(keys.slice(0, 2));
});

test("without R2 there is nothing to clean up", async () => {
  setExternalInboxObjectsForTesting(null);
  expect(await removeExpiredExternalInboxObjects()).toBe(0);
});
