/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { closeDatabase, getDatabase } from "@cocalc/lite/hub/sqlite/database";
import {
  getAccountContentRevokedBeforeMs,
  getAccountRevokedBeforeMs,
  upsertAccountRevocation,
} from "./account-revocations";

const account_id = "1fc5e846-547c-4c78-baa3-d0528685eea0";

describe("account revocations on the host", () => {
  const prevFilename = process.env.COCALC_LITE_SQLITE_FILENAME;

  beforeEach(() => {
    process.env.COCALC_LITE_SQLITE_FILENAME = ":memory:";
    closeDatabase();
  });

  afterEach(() => {
    closeDatabase();
    if (prevFilename == null) {
      delete process.env.COCALC_LITE_SQLITE_FILENAME;
    } else {
      process.env.COCALC_LITE_SQLITE_FILENAME = prevFilename;
    }
  });

  it("content links use the later of the session and the content-only cutoff", () => {
    expect(getAccountContentRevokedBeforeMs(account_id)).toBeUndefined();
    upsertAccountRevocation({
      account_id,
      revoked_before_ms: 0,
      content_revoked_before_ms: 2000,
      updated_ms: 1,
    });
    // A password change revokes content links, not sessions.
    expect(getAccountContentRevokedBeforeMs(account_id)).toBe(2000);
    expect(getAccountRevokedBeforeMs(account_id)).toBe(0);
    // Sign out everywhere later on.
    upsertAccountRevocation({
      account_id,
      revoked_before_ms: 5000,
      updated_ms: 2,
    });
    expect(getAccountContentRevokedBeforeMs(account_id)).toBe(5000);
  });

  it("never moves the content cutoff back (older hubs don't send it)", () => {
    upsertAccountRevocation({
      account_id,
      revoked_before_ms: 0,
      content_revoked_before_ms: 3000,
      updated_ms: 1,
    });
    upsertAccountRevocation({ account_id, revoked_before_ms: 0, updated_ms: 2 });
    upsertAccountRevocation({
      account_id,
      revoked_before_ms: 0,
      content_revoked_before_ms: 1000,
      updated_ms: 3,
    });
    expect(getAccountContentRevokedBeforeMs(account_id)).toBe(3000);
  });

  it("adds the column to a table created by an older host", () => {
    const db = getDatabase();
    db.exec(`
      CREATE TABLE account_revocations (
        account_id TEXT PRIMARY KEY,
        revoked_before_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL
      )
    `);
    db.prepare(
      `INSERT INTO account_revocations(account_id, revoked_before_ms, updated_ms) VALUES(?, ?, ?)`,
    ).run(account_id, 700, 1);
    expect(getAccountContentRevokedBeforeMs(account_id)).toBe(700);
    upsertAccountRevocation({
      account_id,
      revoked_before_ms: 0,
      content_revoked_before_ms: 900,
      updated_ms: 2,
    });
    expect(getAccountContentRevokedBeforeMs(account_id)).toBe(900);
  });
});
