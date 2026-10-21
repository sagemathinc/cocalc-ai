/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The content-only account cutoff against a real database.

import { after, before } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import {
  listAccountRevocationsSince,
  recordAccountRevocation,
  recordContentRevocation,
} from "./revocation";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);

afterAll(after);

function rowFor(
  rows: Awaited<ReturnType<typeof listAccountRevocationsSince>>,
  account_id: string,
) {
  return rows.find((row) => row.account_id === account_id);
}

it("records a content-only cutoff that never moves back and leaves sessions alone", async () => {
  const account_id = uuid();
  await recordContentRevocation(account_id, 2_000_000);
  let row = rowFor(await listAccountRevocationsSince({ limit: 5000 }), account_id);
  expect(row).toMatchObject({ revoked_before_ms: 0, content_revoked_before_ms: 2_000_000 });

  await recordContentRevocation(account_id, 1_000_000);
  row = rowFor(await listAccountRevocationsSince({ limit: 5000 }), account_id);
  expect(row?.content_revoked_before_ms).toBe(2_000_000);

  // Sign out everywhere later: both kept.
  await recordAccountRevocation(account_id, 3_000_000);
  row = rowFor(await listAccountRevocationsSince({ limit: 5000 }), account_id);
  expect(row).toMatchObject({
    revoked_before_ms: 3_000_000,
    content_revoked_before_ms: 2_000_000,
  });
});

it("moves the hosts' sync cursor", async () => {
  const account_id = uuid();
  const before = Date.now() - 1000;
  await recordContentRevocation(account_id);
  const rows = await listAccountRevocationsSince({
    cursor_updated_ms: before,
    limit: 5000,
  });
  expect(rowFor(rows, account_id)).toBeDefined();
});
