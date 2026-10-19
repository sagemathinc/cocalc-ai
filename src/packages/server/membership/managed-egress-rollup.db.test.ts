/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { before, after, getPool } from "@cocalc/server/test";
import { MAX_ROLLUP_SUBJECT_KEYS } from "@cocalc/conat/core/egress-attribution";
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

it("accumulates more subjects than any sample reports, folding only beyond the bucket cap", async () => {
  const account_id = randomUUID();
  const batch = (offset: number) =>
    sample(account_id, 0, {
      top_subjects: Array.from({ length: 200 }, (_, i) => ({
        subject: `s-${offset + i}`,
        bytes: 1 + ((offset + i) % 7),
      })),
    });
  await __test__.flushManagedEgressRollupBatch([batch(0)]);
  await __test__.flushManagedEgressRollupBatch([batch(200)]);
  const { rows } = await getPool().query(
    `SELECT metadata_sample FROM ${__test__.ROLLUP_TABLE} WHERE account_id=$1`,
    [account_id],
  );
  const stored: { subject: string; bytes: number }[] =
    rows[0].metadata_sample.top_subjects;
  expect(stored).toHaveLength(MAX_ROLLUP_SUBJECT_KEYS);
  expect(stored.filter(({ subject }) => subject === "(other)")).toHaveLength(1);
  let expected = 0;
  for (let i = 0; i < 400; i++) expected += 1 + (i % 7);
  expect(stored.reduce((t, { bytes }) => t + bytes, 0)).toBe(expected);
});

it("keeps a subject that is small in every sample but largest over the minute, even past the bucket cap", async () => {
  const { reportedTopEgressSubjects } =
    await import("@cocalc/conat/core/egress-attribution");
  const account_id = randomUUID();
  // a finished minute: its attribution is written on the next flush
  const minute = Date.parse("2026-10-19T18:47:00.000Z");
  let expectedTotal = 0;
  for (let i = 0; i < 12; i++) {
    const top_subjects = [{ subject: "recurring", bytes: 10 }];
    for (let j = 0; j < 255; j++) {
      top_subjects.push({ subject: `once-${i}-${j}`, bytes: 100 });
    }
    expectedTotal += 10 + 255 * 100;
    await __test__.recordManagedProjectEgressRollup({
      account_id,
      category: "control-plane-conat",
      bytes: 10 + 255 * 100,
      metadata: { browser_ids: [`b${i}`], top_subjects },
      occurred_at: new Date(minute + i * 5000),
    });
  }
  await __test__.flushManagedEgressRollups();
  const { rows } = await getPool().query(
    `SELECT bytes, event_count, metadata_sample FROM ${__test__.ROLLUP_TABLE}
      WHERE account_id=$1`,
    [account_id],
  );
  expect(rows).toHaveLength(1);
  expect(Number(rows[0].bytes)).toBe(expectedTotal);
  expect(rows[0].event_count).toBe(12);
  expect(rows[0].metadata_sample.browser_ids).toEqual(["b0"]);
  const stored: { subject: string; bytes: number }[] =
    rows[0].metadata_sample.top_subjects;
  expect(stored).toHaveLength(MAX_ROLLUP_SUBJECT_KEYS);
  expect(stored.find(({ subject }) => subject === "recurring")).toEqual({
    subject: "recurring",
    bytes: 120,
  });
  expect(stored.reduce((t, { bytes }) => t + bytes, 0)).toBe(expectedTotal);
  const reported = reportedTopEgressSubjects(stored);
  expect(reported.filter(({ subject }) => subject !== "(other)")[0]).toEqual({
    subject: "recurring",
    bytes: 120,
  });
});
