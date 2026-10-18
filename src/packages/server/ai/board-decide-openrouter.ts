/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The first `decide` provider: a decision model through OpenRouter's
// Decisions API (POST /api/alpha/decisions; TypeSafe's Jev,
// typesafe/jev-1.14). Schema as in OpenRouter's API reference, confirmed
// Oct 16 2026:
//
//   request:  { model, state, questions: { q: { type: "choice",
//               instructions, criteria: { optionName: description } } },
//               provider: { zdr, data_collection } }
//   response: { answers: { q: { type: "choice", choice, probabilities?,
//               confidence? } }, usage: { input_tokens, output_tokens,
//               cost (USD) } }
//   errors:   { error: { code, message } }
//
// What is sent: the reader's answer (the state), and the question's text
// and option names and descriptions (instructions and criteria). Nothing
// else: no account, file name or other part of the board. Every request
// asks for zero data retention.

import type {
  DecideProvider,
  DecideProviderResult,
  DecideQuestion,
} from "./board-decide";

export const OPENROUTER_DECISIONS_URL =
  "https://openrouter.ai/api/alpha/decisions";
const QUESTION = "reader_answer";
const TIMEOUT_MS = 10_000;

export function openRouterDecideProvider({
  apiKey,
  model = "typesafe/jev-1.14",
  usdPerMillionInputTokens = 0.042,
  fetchImpl = fetch,
  url = OPENROUTER_DECISIONS_URL,
}: {
  /** Read when a call is made, from the site secret; never logged. */
  apiKey: () => Promise<string | undefined>;
  model?: string;
  usdPerMillionInputTokens?: number;
  fetchImpl?: typeof fetch;
  url?: string;
}): DecideProvider {
  const microusdPerToken = usdPerMillionInputTokens; // $/1e6 tokens = µ$/token
  return {
    maxCostMicrousd(question, answer) {
      // A real bound: input tokens can't outnumber the request body's UTF-8
      // bytes (every token covers at least one byte), the price per input
      // token is capped by max_price, and output and per-request charges
      // are capped at 0. A 25% margin covers the provider's own framing.
      const bytes = new TextEncoder().encode(
        JSON.stringify(
          decisionsRequest(model, question, answer, usdPerMillionInputTokens),
        ),
      ).length;
      return bytes * microusdPerToken * 1.25;
    },
    async decide(question, answer, signal) {
      const key = await apiKey();
      if (!key) throw new Error("decide provider is not configured");
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          decisionsRequest(model, question, answer, usdPerMillionInputTokens),
        ),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        // The status only: the body is the provider's words.
        throw new Error(`decide provider returned ${response.status}`);
      }
      return parseDecisionsResponse(question, await response.json());
    },
  };
}

export function decisionsRequest(
  model: string,
  question: DecideQuestion,
  answer: string,
  usdPerMillionInputTokens: number,
) {
  // Keyed by the board's own option names, so with no prototype: on a
  // plain {}, an option named "__proto__" would hit the prototype setter
  // and never reach the model (Codex on #1134). JSON.stringify sends its
  // own keys, "__proto__" too.
  const criteria: Record<string, string> = Object.create(null);
  for (const { name, about } of question.options) {
    criteria[name] = about ?? name;
  }
  return {
    model,
    state: answer,
    questions: {
      [QUESTION]: {
        type: "choice",
        instructions: question.prompt,
        criteria,
      },
    },
    provider: {
      zdr: true,
      data_collection: "deny",
      // The price CoCalc reserves for: no provider may charge more.
      max_price: {
        prompt: usdPerMillionInputTokens,
        completion: 0,
        request: 0,
      },
    },
  };
}

export function parseDecisionsResponse(
  _question: DecideQuestion,
  body: unknown,
): DecideProviderResult {
  const answer = (body as any)?.answers?.[QUESTION];
  if (
    answer == null ||
    typeof answer !== "object" ||
    answer.type !== "choice"
  ) {
    throw new Error("decide provider returned no choice");
  }
  const probabilities = answer.probabilities;
  let options: { name: string; p: number }[];
  if (probabilities != null && typeof probabilities === "object") {
    options = Object.entries(probabilities).map(([name, p]) => ({
      name,
      p: p as number,
    }));
  } else if (typeof answer.choice === "string") {
    // Probabilities are optional in the API: then only the choice is known.
    options = [{ name: answer.choice, p: 1 }];
  } else {
    throw new Error("decide provider returned no choice");
  }
  // Without a confidence the result counts as unsure, so the board falls
  // back to the agent.
  const confidence =
    typeof answer.confidence === "number" ? answer.confidence : 0;
  const cost = (body as any)?.usage?.cost;
  return {
    options,
    confidence,
    ...(typeof cost === "number" && Number.isFinite(cost)
      ? { costMicrousd: cost * 1e6 }
      : {}),
  };
}
