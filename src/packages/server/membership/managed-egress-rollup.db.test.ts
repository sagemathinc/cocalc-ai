/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { before, after, getPool } from "@cocalc/server/test";
import { __test__ } from "./managed-egress";

beforeAll(async () => {
  await before({ noConat: true });
}, 30000);
afterAll(after);

const sample = (account_id: string, bytes: number, metadata: object) => ({
  bucket_start: new Date("2026-10-19T18:47:00.000Z"),
  account_id,
  category: "control-plane-conat" as const,
  bytes,
  event_count: 1,
  first_occurred_at: new Date("2026-10-19T18:47:05.000Z"),
  last_occurred_at: new Date("2026-10-19T18:47:05.000Z"),
  metadata_sample: metadata as Record<string, unknown>,
});

it("sums top_subjects over every sample flushed into a bucket, keeping the first sample's other metadata", async () => {
  const account_id = randomUUID();
  await __test__.flushManagedEgressRollupBatch([
    sample(account_id, 1000, {
      browser_ids: ["first"],
      top_subjects: [
        { subject: "reply:hub.account.*.api", bytes: 600 },
        { subject: "(control)", bytes: 400 },
      ],
    }),
  ]);
  await __test__.flushManagedEgressRollupBatch([
    sample(account_id, 3000, {
      browser_ids: ["second"],
      top_subjects: [
        { subject: "reply:persist.*.server.*.*", bytes: 2500 },
        { subject: "(control)", bytes: 500 },
      ],
    }),
  ]);
  const { rows } = await getPool().query(
    `SELECT bytes, event_count, metadata_sample FROM ${__test__.ROLLUP_TABLE}
      WHERE account_id=$1`,
    [account_id],
  );
  expect(rows).toHaveLength(1);
  expect(Number(rows[0].bytes)).toBe(4000);
  expect(rows[0].event_count).toBe(2);
  expect(rows[0].metadata_sample.browser_ids).toEqual(["first"]);
  expect(rows[0].metadata_sample.top_subjects).toEqual([
    { subject: "reply:persist.*.server.*.*", bytes: 2500 },
    { subject: "(control)", bytes: 900 },
    { subject: "reply:hub.account.*.api", bytes: 600 },
  ]);
});

it("keeps the first sample's metadata as before when samples have no top_subjects", async () => {
  const account_id = randomUUID();
  await __test__.flushManagedEgressRollupBatch([
    sample(account_id, 10, { browser_ids: ["a"] }),
  ]);
  await __test__.flushManagedEgressRollupBatch([
    sample(account_id, 20, { browser_ids: ["b"] }),
  ]);
  const { rows } = await getPool().query(
    `SELECT metadata_sample FROM ${__test__.ROLLUP_TABLE} WHERE account_id=$1`,
    [account_id],
  );
  expect(rows[0].metadata_sample).toEqual({ browser_ids: ["a"] });
});
