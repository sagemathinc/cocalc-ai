/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { db } from "@cocalc/database";

let database: ReturnType<typeof db>;

beforeAll(async () => {
  await initEphemeralDatabase({ reset: true });
  database = db();
}, 30000);

afterAll(async () => {
  database.disconnect();
  await getPool().end();
});

test("LISTEN/UNLISTEN queries are rejected explicitly", async () => {
  await expect(
    database.async_query({ query: "LISTEN route_updates" }),
  ).rejects.toEqual(
    expect.stringContaining(
      "raw LISTEN/UNLISTEN queries are no longer supported",
    ),
  );
  await expect(
    database.async_query({ query: "UNLISTEN route_updates" }),
  ).rejects.toEqual(
    expect.stringContaining(
      "raw LISTEN/UNLISTEN queries are no longer supported",
    ),
  );
});
