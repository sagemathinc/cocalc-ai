/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A fake OpenRouter Decisions endpoint for the multibay board-decide test,
// preloaded into the test cluster's hubs (`node --require`, set by
// cluster.mjs). It lives in the test tree only: no production code reads a
// switch for it, and nothing in a package refers to it.
//
// It refuses to act unless all of these hold:
// - MULTIBAY_BOARD_DECIDE_FAKE is "1" (cluster.mjs sets it for its hubs
//   only). Without the marker it does nothing at all, so a stray preload is
//   inert.
// - The hub listens on loopback (HOST is 127.0.0.1, ::1 or localhost). With
//   the marker but any other host it throws, so a hub that has the marker by
//   mistake fails to start rather than fake anything.
// It answers only POSTs to exactly OPENROUTER_DECISIONS_URL; every other
// fetch goes to the real one unchanged.
//
// Its answer is the request's first option at p = 0.9 with confidence 0.9.
// Each call is appended as one JSON line ({ bay, criteria, state }) to
// MULTIBAY_BOARD_DECIDE_LOG, so the test can see which bay asked and what
// the question was.

"use strict";

const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

if (process.env.MULTIBAY_BOARD_DECIDE_FAKE === "1") {
  const host = `${process.env.HOST ?? ""}`.trim();
  if (!LOOPBACK.has(host)) {
    throw new Error(
      `board-decide-fake: refusing to load on a hub not on loopback (HOST=${JSON.stringify(host)})`,
    );
  }
  const { appendFileSync } = require("node:fs");
  const log = process.env.MULTIBAY_BOARD_DECIDE_LOG;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async function fetch(input, init) {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input?.url;
    if (url !== OPENROUTER_DECISIONS_URL || `${init?.method}` !== "POST") {
      return await realFetch(input, init);
    }
    const body = JSON.parse(`${init?.body ?? "{}"}`);
    const question = body?.questions?.reader_answer ?? {};
    const names = Object.keys(question.criteria ?? {});
    if (log) {
      appendFileSync(
        log,
        JSON.stringify({
          bay: process.env.COCALC_BAY_ID,
          criteria: question.criteria ?? null,
          instructions: question.instructions ?? null,
          state: body?.state ?? null,
        }) + "\n",
      );
    }
    const probabilities = Object.fromEntries(
      names.map((name, i) => [name, i === 0 ? 0.9 : 0.1 / (names.length - 1)]),
    );
    return new Response(
      JSON.stringify({
        id: "gen-multibay",
        model: body?.model,
        answers: {
          reader_answer: {
            type: "choice",
            choice: names[0],
            probabilities,
            confidence: 0.9,
          },
        },
        usage: { input_tokens: 10, output_tokens: 0, cost: 0.000001 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}
