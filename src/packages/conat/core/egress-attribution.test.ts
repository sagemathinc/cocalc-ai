/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  addEgressBytes,
  diffEgressBySubject,
  MAX_EGRESS_SUBJECT_KEYS,
  normalizeSubjectForAttribution,
  OTHER_KEY,
  ReplySubjectAttribution,
  topEgressSubjects,
} from "./egress-attribution";

describe("egress attribution", () => {
  it("collapses identifiers so cardinality stays bounded", () => {
    expect(
      normalizeSubjectForAttribution(
        "project.9f6f3b0e-6f47-4a59-8a8a-0b6d7c1b2a33.api",
      ),
    ).toBe("project.*.api");
    expect(normalizeSubjectForAttribution("_INBOX.k3j4h5g6f7d8.12")).toBe(
      "_INBOX.*.*",
    );
    expect(normalizeSubjectForAttribution("a.b.c.d.e.f.g.h")).toBe(
      "a.b.c.d.e.f.>",
    );
    expect(normalizeSubjectForAttribution("hub.account.api")).toBe(
      "hub.account.api",
    );
  });

  it("caps distinct keys per socket, summing the rest under (other)", () => {
    const by: Record<string, number> = {};
    for (let i = 0; i < MAX_EGRESS_SUBJECT_KEYS + 5; i++) {
      addEgressBytes(by, `key-${String.fromCharCode(97 + (i % 26))}${i}`, 1);
    }
    expect(Object.keys(by).length).toBe(MAX_EGRESS_SUBJECT_KEYS + 1);
    expect(by[OTHER_KEY]).toBe(5);
  });

  it("labels replies with the request subject until they expire", () => {
    const replies = new ReplySubjectAttribution(2, 1000);
    replies.remember("_INBOX.abc123def456.1", "persist.x.history", 0);
    expect(replies.label("_INBOX.abc123def456.1", 500)).toBe(
      "reply:persist.x.history",
    );
    expect(replies.label("_INBOX.abc123def456.1", 2000)).toBe("_INBOX.*.*");
    // bounded size: the oldest entry is evicted
    replies.remember("r1", "s1", 0);
    replies.remember("r2", "s2", 0);
    replies.remember("r3", "s3", 0);
    expect(replies.lookup("r1", 0)).toBeUndefined();
    expect(replies.lookup("r3", 0)).toBe("s3");
  });

  it("diffs counters and ranks the top subjects", () => {
    const delta = diffEgressBySubject({ a: 10, b: 5, c: 1 }, { a: 4, b: 9 });
    // b went backwards (socket reconnected): count its current value
    expect(delta).toEqual({ a: 6, b: 5, c: 1 });
    expect(topEgressSubjects(delta, 2)).toEqual([
      { subject: "a", bytes: 6 },
      { subject: "b", bytes: 5 },
    ]);
  });
});
