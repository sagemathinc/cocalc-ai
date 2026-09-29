/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { ExamTokenFailureLimit } from "./token-failure-limit";

function createLimit({ limit = 12 }: { limit?: number } = {}) {
  let now = 1_000;
  const failures = new ExamTokenFailureLimit({
    fingerprint_key: Buffer.alloc(32, 7),
    limit,
    now: () => now,
    source_limit: 100,
    window_ms: 10_000,
  });
  return {
    failures,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("exam token failure limit", () => {
  it("counts one shared stale token once across a classroom source", () => {
    const { failures } = createLimit();
    const attempt = {
      source: "classroom-nat",
      token: "rotated-away-token",
      token_hash: "current-token-hash",
    };

    expect(failures.knownInvalidOrThrow(attempt)).toBe(false);
    failures.noteInvalid(attempt);
    for (let student = 1; student < 20; student++) {
      expect(failures.knownInvalidOrThrow(attempt)).toBe(true);
    }

    // A current token remains eligible for verification instead of being
    // blocked by one stale value repeated from many tabs behind the same NAT.
    expect(
      failures.knownInvalidOrThrow({
        ...attempt,
        token: "current-token",
      }),
    ).toBe(false);
  });

  it("still limits distinct guesses", () => {
    const { failures } = createLimit({ limit: 3 });
    const base = {
      source: "guessing-source",
      token_hash: "current-token-hash",
    };
    for (const token of ["guess-1", "guess-2", "guess-3"]) {
      const attempt = { ...base, token };
      expect(failures.knownInvalidOrThrow(attempt)).toBe(false);
      failures.noteInvalid(attempt);
    }
    expect(() =>
      failures.knownInvalidOrThrow({ ...base, token: "guess-4" }),
    ).toThrow("too many unsuccessful exam join attempts; try later");
  });

  it("does not carry failures across a token rotation or the time window", () => {
    const { failures, advance } = createLimit({ limit: 1 });
    const attempt = {
      source: "classroom-nat",
      token: "wrong-token",
      token_hash: "first-token-hash",
    };
    failures.noteInvalid(attempt);

    expect(
      failures.knownInvalidOrThrow({
        ...attempt,
        token_hash: "rotated-token-hash",
      }),
    ).toBe(false);

    failures.noteInvalid(attempt);
    advance(10_000);
    expect(failures.knownInvalidOrThrow(attempt)).toBe(false);
  });
});
