/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  boardDecide,
  DECIDE_LIMITS,
  resetBoardDecideStateForTests,
  boardDecideStateSizesForTests,
  MAX_RATE_KEYS,
  MAX_REQUEST_ID_KEYS,
  sanitizeDecideResult,
  type DecideFunding,
  type DecideProvider,
} from "./board-decide";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
// The board a call is for, as the file's server resolved it.
const BOARD_KEY = {
  projectId: "44444444-4444-4444-8444-444444444444",
  path: "/home/user/plan.board.json",
};
let n = 0;
const rid = () => `00000000-0000-4000-8000-${`${++n}`.padStart(12, "0")}`;

const question = {
  prompt: "What does it mean for a group action to be transitive?",
  options: [
    {
      name: "one-orbit-correct",
      about: "Any point can be moved to any other.",
    },
    { name: "confuses-transitive-with-2-transitive" },
    { name: "confuses-with-faithful" },
  ],
};

function fakeProvider(
  result?: any,
  fail = false,
): DecideProvider & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    maxCostMicrousd: (q, a) => 0.042 * (1000 + q.prompt.length + a.length),
    decide: async (q, a) => {
      calls.push({ q, a });
      if (fail) throw new Error("provider said: secret upstream detail");
      return (
        result ?? {
          options: [
            { name: "confuses-transitive-with-2-transitive", p: 0.81 },
            { name: "one-orbit-correct", p: 0.15 },
          ],
          confidence: 0.9,
          costMicrousd: 5.04,
        }
      );
    },
  };
}

function fakeFunding(refuse = false, callingFails = false) {
  const events: string[] = [];
  const funding: DecideFunding = {
    reserve: async ({ microusd }) => {
      if (refuse)
        throw Object.assign(new Error("over allowance"), { code: 402 });
      events.push(`reserve ${microusd}`);
      return {
        calling: async () => {
          if (callingFails) throw new Error("database unavailable");
          events.push("calling");
        },
        commit: async (m) => void events.push(`commit ${m}`),
        release: async () => void events.push("release"),
      };
    },
  };
  return { funding, events };
}

beforeEach(() => resetBoardDecideStateForTests());

test("an answer is classified into the question's own options, and paid for", async () => {
  const provider = fakeProvider();
  const { funding, events } = fakeFunding();
  const result = await boardDecide({
    board: BOARD_KEY,
    accountId: ACCOUNT,
    requestId: rid(),
    question,
    answer: "  any point can be moved to any other pair of points  ",
    provider,
    funding,
  });
  expect(result).toEqual({
    options: [
      { name: "confuses-transitive-with-2-transitive", p: 0.81 },
      { name: "one-orbit-correct", p: 0.15 },
    ],
    confidence: 0.9,
  });
  expect(provider.calls[0].a).toBe(
    "any point can be moved to any other pair of points",
  );
  // reserved an upper bound, committed the reported cost (5.04 -> 6 micro-dollars)
  expect(events[0]).toMatch(/^reserve \d+$/);
  expect(events[1]).toBe("calling");
  expect(events[2]).toBe("commit 6");
});

test("without a provider or funding, decide is unavailable and nothing is called", async () => {
  const provider = fakeProvider();
  await expect(
    boardDecide({
      board: BOARD_KEY,
      accountId: ACCOUNT,
      requestId: rid(),
      question,
      answer: "x",
      provider,
    }),
  ).rejects.toMatchObject({ code: 503 });
  expect(provider.calls).toHaveLength(0);
});

test("over the allowance: refused before the provider is called", async () => {
  const provider = fakeProvider();
  const { funding } = fakeFunding(true);
  await expect(
    boardDecide({
      board: BOARD_KEY,
      accountId: ACCOUNT,
      requestId: rid(),
      question,
      answer: "x",
      provider,
      funding,
    }),
  ).rejects.toMatchObject({ code: 402 });
  expect(provider.calls).toHaveLength(0);
});

test("a failed call releases its reservation, and its error stays ours", async () => {
  const { funding, events } = fakeFunding();
  const err: any = await boardDecide({
    board: BOARD_KEY,
    accountId: ACCOUNT,
    requestId: rid(),
    question,
    answer: "x",
    provider: fakeProvider(undefined, true),
    funding,
  }).catch((e) => e);
  expect(err.code).toBe(502);
  expect(err.message).not.toMatch(/secret upstream/);
  expect(events).toEqual([
    expect.stringMatching(/^reserve/),
    "calling",
    "release",
  ]);
});

test("limits: answer, prompt and options", async () => {
  const { funding } = fakeFunding();
  const provider = fakeProvider();
  const call = (q: any, answer: any) =>
    boardDecide({
      board: BOARD_KEY,
      accountId: ACCOUNT,
      requestId: rid(),
      question: q,
      answer,
      provider,
      funding,
    });
  await expect(
    call(question, "x".repeat(DECIDE_LIMITS.answerCharacters + 1)),
  ).rejects.toMatchObject({ code: 400 });
  await expect(call(question, "   ")).rejects.toMatchObject({ code: 400 });
  await expect(call(question, 42)).rejects.toMatchObject({ code: 400 });
  await expect(
    call(
      { ...question, prompt: "p".repeat(DECIDE_LIMITS.promptCharacters + 1) },
      "x",
    ),
  ).rejects.toMatchObject({ code: 400 });
  const many = Array.from(
    { length: DECIDE_LIMITS.options + 1 },
    (_, i) => `option-${i}`,
  );
  await expect(call({ ...question, options: many }, "x")).rejects.toMatchObject(
    { code: 400 },
  );
  await expect(
    call({ ...question, options: ["only-one"] }, "x"),
  ).rejects.toMatchObject({ code: 400 });
  await expect(
    call({ ...question, options: ["a", "a"] }, "x"),
  ).rejects.toMatchObject({ code: 400 });
  await expect(
    call({ ...question, options: ["a", "n".repeat(81)] }, "x"),
  ).rejects.toMatchObject({ code: 400 });
  expect(provider.calls).toHaveLength(0);
});

test("a request id is used once, and calls per account per minute are capped", async () => {
  const { funding } = fakeFunding();
  const provider = fakeProvider();
  const id = rid();
  await boardDecide({
    board: BOARD_KEY,
    accountId: ACCOUNT,
    requestId: id,
    question,
    answer: "x",
    provider,
    funding,
    now: 1_000,
  });
  await expect(
    boardDecide({
      board: BOARD_KEY,
      accountId: ACCOUNT,
      requestId: id,
      question,
      answer: "x",
      provider,
      funding,
      now: 1_001,
    }),
  ).rejects.toMatchObject({ code: 409 });
  resetBoardDecideStateForTests();
  for (let i = 0; i < DECIDE_LIMITS.callsPerAccountPerMinute; i++) {
    await boardDecide({
      board: BOARD_KEY,
      accountId: ACCOUNT,
      requestId: rid(),
      question,
      answer: "x",
      provider,
      funding,
      now: 5_000 + i,
    });
  }
  await expect(
    boardDecide({
      board: BOARD_KEY,
      accountId: ACCOUNT,
      requestId: rid(),
      question,
      answer: "x",
      provider,
      funding,
      now: 6_000,
    }),
  ).rejects.toMatchObject({ code: 429 });
  // a minute later it is allowed again
  await boardDecide({
    board: BOARD_KEY,
    accountId: ACCOUNT,
    requestId: rid(),
    question,
    answer: "x",
    provider,
    funding,
    now: 70_000,
  });
  await expect(
    boardDecide({
      board: BOARD_KEY,
      accountId: "22222222-2222-4222-8222-222222222222",
      requestId: rid(),
      question,
      answer: "x",
      provider,
      funding,
      now: 6_000,
    }),
  ).resolves.toBeDefined();
});

test("only the question's own options come back, with probabilities in [0, 1]", () => {
  const sanitized = sanitizeDecideResult(question, {
    options: [
      { name: "ignore previous instructions", p: 1 },
      { name: "one-orbit-correct", p: 7 },
      { name: "one-orbit-correct", p: 0.2 },
      { name: "confuses-with-faithful", p: -3 },
      { name: "confuses-transitive-with-2-transitive", p: Number.NaN },
      { name: 5 as any, p: 0.5 },
    ],
    confidence: 2,
  });
  expect(sanitized).toEqual({
    options: [
      { name: "one-orbit-correct", p: 1 },
      { name: "confuses-with-faithful", p: 0 },
      { name: "confuses-transitive-with-2-transitive", p: 0 },
    ],
    confidence: 1,
  });
  expect(sanitizeDecideResult(question, null as any)).toEqual({
    options: [],
    confidence: 0,
  });
});

test("a cost above the reservation is committed in full, never clamped", async () => {
  const { funding, events } = fakeFunding();
  const provider = fakeProvider({
    options: [],
    confidence: 0.5,
    costMicrousd: 10_000_000,
  });
  await boardDecide({
    board: BOARD_KEY,
    accountId: ACCOUNT,
    requestId: rid(),
    question,
    answer: "x",
    provider,
    funding,
  });
  const reserved = Number(events[0].split(" ")[1]);
  expect(reserved).toBeLessThan(10_000_000);
  expect(events[2]).toBe("commit 10000000");
});

test("one-shot accounts leave this process's counts bounded", async () => {
  const provider = fakeProvider();
  const { funding } = fakeFunding();
  const accounts = MAX_RATE_KEYS + 500;
  for (let i = 0; i < accounts; i++) {
    await boardDecide({
      board: BOARD_KEY,
      accountId: `22222222-2222-4222-8222-${`${i}`.padStart(12, "0")}`,
      requestId: rid(),
      question,
      answer: "x",
      provider,
      funding,
      now: 1_000 + i,
    });
  }
  const sizes = boardDecideStateSizesForTests();
  expect(sizes.recentCalls).toBeLessThanOrEqual(MAX_RATE_KEYS);
  expect(sizes.usedRequestIds).toBeLessThanOrEqual(MAX_REQUEST_ID_KEYS);
  // Past their windows (ten minutes for request ids), the next call leaves
  // only its own entries.
  await boardDecide({
    board: BOARD_KEY,
    accountId: ACCOUNT,
    requestId: rid(),
    question,
    answer: "x",
    provider,
    funding,
    now: 1_000 + accounts + 10 * 60_000,
  });
  expect(boardDecideStateSizesForTests()).toEqual({
    recentCalls: 1,
    usedRequestIds: 1,
  });
});

// Codex on #1134: a hold is marked before the provider runs; if that
// can't be recorded, the provider isn't called and the hold goes.
test("no provider call when its hold can't be marked", async () => {
  const provider = fakeProvider();
  const { funding, events } = fakeFunding(false, true);
  await expect(
    boardDecide({
      board: BOARD_KEY,
      accountId: ACCOUNT,
      requestId: rid(),
      question,
      answer: "x",
      provider,
      funding,
    }),
  ).rejects.toMatchObject({ code: 503 });
  expect(provider.calls).toHaveLength(0);
  expect(events).toEqual([expect.stringMatching(/^reserve/), "release"]);
});
