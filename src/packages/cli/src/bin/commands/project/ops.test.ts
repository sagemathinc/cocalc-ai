import assert from "node:assert/strict";
import test from "node:test";

import {
  assertProjectRehomeConfirmed,
  getMovePlacementFallbackTimeoutMs,
  readProjectLogPage,
} from "./ops";

test("getMovePlacementFallbackTimeoutMs preserves the full timeout for timed out move waits", () => {
  assert.equal(
    getMovePlacementFallbackTimeoutMs(
      { status: "running", timedOut: true },
      1_800_000,
    ),
    1_800_000,
  );
});

test("getMovePlacementFallbackTimeoutMs caps explicit move failures to a short placement check", () => {
  assert.equal(
    getMovePlacementFallbackTimeoutMs(
      { status: "failed", timedOut: false },
      1_800_000,
    ),
    10_000,
  );
});

test("getMovePlacementFallbackTimeoutMs respects shorter command timeouts", () => {
  assert.equal(
    getMovePlacementFallbackTimeoutMs(
      { status: "failed", timedOut: false },
      5_000,
    ),
    5_000,
  );
});

test("assertProjectRehomeConfirmed refuses rehome without --yes", () => {
  assert.throws(
    () =>
      assertProjectRehomeConfirmed({
        project_id: "project-id",
        dest_bay_id: "bay-2",
      }),
    /without --yes/,
  );
  assert.doesNotThrow(() =>
    assertProjectRehomeConfirmed({
      project_id: "project-id",
      dest_bay_id: "bay-2",
      yes: true,
    }),
  );
});

test("readProjectLogPage deduplicates by id and returns newest rows first", async () => {
  async function* getAll() {
    yield {
      seq: 1,
      time: Date.parse("2026-04-11T20:00:00.000Z"),
      mesg: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        project_id: "project-id",
        account_id: "account-a",
        event: { event: "older" },
      },
    };
    yield {
      seq: 2,
      time: Date.parse("2026-04-11T21:00:00.000Z"),
      mesg: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        project_id: "project-id",
        account_id: "account-a",
        event: { event: "newer" },
      },
    };
    yield {
      seq: 3,
      time: Date.parse("2026-04-11T20:30:00.000Z"),
      mesg: {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
        project_id: "project-id",
        account_id: "account-b",
        event: { event: "other" },
      },
    };
  }

  const page = await readProjectLogPage({
    stream: { getAll },
    project_id: "project-id",
    limit: 1,
  });

  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0]?.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1");
  assert.deepEqual(page.entries[0]?.event, { event: "newer" });
  assert.equal(page.has_more, true);
});
