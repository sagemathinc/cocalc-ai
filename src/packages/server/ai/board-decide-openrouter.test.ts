/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  decisionsRequest,
  OPENROUTER_DECISIONS_URL,
  openRouterDecideProvider,
  parseDecisionsResponse,
} from "./board-decide-openrouter";
import { sanitizeDecideResult } from "./board-decide";
import { chooseDecidedOption } from "./board-decide-bound";

const question = {
  prompt: "What does it mean for a group action to be transitive?",
  options: [
    {
      name: "one-orbit-correct",
      about: "Any point can be moved to any other.",
    },
    { name: "confuses-transitive-with-2-transitive" },
  ],
};
const ANSWER = "every pair of points goes to every pair";

// The response shape from OpenRouter's Decisions API reference.
const RESPONSE = {
  id: "gen-1",
  model: "typesafe/jev-1.14",
  provider: "TypeSafe",
  answers: {
    reader_answer: {
      type: "choice",
      choice: "confuses-transitive-with-2-transitive",
      probabilities: {
        "one-orbit-correct": 0.12,
        "confuses-transitive-with-2-transitive": 0.88,
      },
      confidence: 0.74,
    },
  },
  usage: { input_tokens: 143, output_tokens: 0, cost: 0.000006 },
};

test("the request: the answer as state, the board's question and options, zero data retention", () => {
  expect(
    decisionsRequest("typesafe/jev-1.14", question, ANSWER, 0.042),
  ).toEqual({
    model: "typesafe/jev-1.14",
    state: ANSWER,
    questions: {
      reader_answer: {
        type: "choice",
        instructions: question.prompt,
        criteria: {
          "one-orbit-correct": "Any point can be moved to any other.",
          "confuses-transitive-with-2-transitive":
            "confuses-transitive-with-2-transitive",
        },
      },
    },
    provider: {
      zdr: true,
      data_collection: "deny",
      max_price: { prompt: 0.042, completion: 0, request: 0 },
    },
  });
});

test("the response: probabilities, confidence and the reported cost", () => {
  const parsed = parseDecisionsResponse(question, RESPONSE);
  expect(parsed.options).toEqual([
    { name: "one-orbit-correct", p: 0.12 },
    { name: "confuses-transitive-with-2-transitive", p: 0.88 },
  ]);
  expect(parsed.confidence).toBe(0.74);
  expect(parsed.costMicrousd).toBeCloseTo(6, 9); // $0.000006
});

test("without probabilities only the choice is known; without confidence it is unsure", () => {
  expect(
    parseDecisionsResponse(question, {
      answers: {
        reader_answer: { type: "choice", choice: "one-orbit-correct" },
      },
    }),
  ).toEqual({ options: [{ name: "one-orbit-correct", p: 1 }], confidence: 0 });
});

test("a response without a choice is an error", () => {
  expect(() => parseDecisionsResponse(question, { answers: {} })).toThrow();
  expect(() =>
    parseDecisionsResponse(question, {
      answers: { reader_answer: { type: "score", score: 2 } },
    }),
  ).toThrow();
  expect(() => parseDecisionsResponse(question, null)).toThrow();
});

test("a call posts to the Decisions API with the key, and reports only the status on errors", async () => {
  const calls: any[] = [];
  const ok = openRouterDecideProvider({
    apiKey: async () => "sk-test-not-a-real-key",
    fetchImpl: (async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => RESPONSE } as any;
    }) as any,
  });
  const result = await ok.decide(question, ANSWER);
  expect(result.confidence).toBe(0.74);
  expect(calls[0].url).toBe(OPENROUTER_DECISIONS_URL);
  expect(calls[0].init.headers.Authorization).toBe(
    "Bearer sk-test-not-a-real-key",
  );
  expect(JSON.parse(calls[0].init.body).state).toBe(ANSWER);

  const failing = openRouterDecideProvider({
    apiKey: async () => "sk-test-not-a-real-key",
    fetchImpl: (async () =>
      ({
        ok: false,
        status: 402,
        json: async () => ({
          error: { code: 402, message: "Insufficient credits; key sk-..." },
        }),
      }) as any) as any,
  });
  const err: any = await failing.decide(question, ANSWER).catch((e) => e);
  expect(err.message).toBe("decide provider returned 402");
});

test("no key: not configured, and nothing is sent", async () => {
  const fetchImpl = jest.fn();
  const provider = openRouterDecideProvider({
    apiKey: async () => undefined,
    fetchImpl: fetchImpl as any,
  });
  await expect(provider.decide(question, ANSWER)).rejects.toThrow(
    "not configured",
  );
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("the cost bound: the request's bytes at the capped price, with a margin", () => {
  const provider = openRouterDecideProvider({ apiKey: async () => "k" });
  const bytes = new TextEncoder().encode(
    JSON.stringify(
      decisionsRequest("typesafe/jev-1.14", question, ANSWER, 0.042),
    ),
  ).length;
  // Input tokens can't outnumber the body's UTF-8 bytes; max_price caps the
  // price per token and charges nothing else, so this bounds the bill.
  expect(provider.maxCostMicrousd(question, ANSWER)).toBeCloseTo(
    bytes * 0.042 * 1.25,
    9,
  );
  // Non-ASCII text counts its bytes, not its characters.
  const wide = "é".repeat(100);
  expect(provider.maxCostMicrousd(question, wide)).toBeGreaterThan(
    provider.maxCostMicrousd(question, "e".repeat(100)),
  );
  // A typical call (143 tokens: 6 micro-dollars) is well inside it.
  expect(provider.maxCostMicrousd(question, ANSWER)).toBeGreaterThan(6);
});

// Codex on #1134: options are named by the board, so any name, including
// the ones an object's prototype has, must reach the model and come back.
test("options named like Object.prototype's keys reach the model and come back", async () => {
  const names = ["__proto__", "constructor", "toString", "hasOwnProperty"];
  const tricky = {
    prompt: "Which one?",
    options: names.map((name) => ({ name, about: `means ${name}` })),
  };
  const calls: any[] = [];
  const provider = openRouterDecideProvider({
    apiKey: async () => "sk-test-not-a-real-key",
    fetchImpl: (async (_url: string, init: any) => {
      calls.push(init);
      // the provider's reply as text, parsed as fetch's json() would
      const probabilities = `{${names
        .map((n, i) => `${JSON.stringify(n)}: ${i === 0 ? 0.7 : 0.1}`)
        .join(", ")}}`;
      const text = `{"answers": {"reader_answer": {"type": "choice", "choice": "__proto__", "probabilities": ${probabilities}, "confidence": 0.9}}}`;
      return {
        ok: true,
        status: 200,
        json: async () => JSON.parse(text),
      } as any;
    }) as any,
  });
  const result = await provider.decide(tricky, "the first");
  // the serialized request names every option, in order, with its words
  const criteria = JSON.parse(calls[0].body).questions.reader_answer.criteria;
  expect(Object.keys(criteria)).toEqual(names);
  for (const name of names) {
    expect(Object.getOwnPropertyDescriptor(criteria, name)?.value).toBe(
      `means ${name}`,
    );
  }
  // and the reply's probabilities for each come back, the best chosen
  const clean = sanitizeDecideResult(tricky, result);
  expect(clean.options.map((o) => o.name).sort()).toEqual([...names].sort());
  expect(clean.options[0]).toEqual({ name: "__proto__", p: 0.7 });
  expect(chooseDecidedOption(clean, names)).toBe("__proto__");
});
