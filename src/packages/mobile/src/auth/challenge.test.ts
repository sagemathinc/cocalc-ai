/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import assert from "node:assert/strict";
import test from "node:test";

import { startLoginChallenge } from "./challenge";
import { normalizeSiteUrl } from "./site-url";

test("identifies a browser login challenge as a mobile app request", async () => {
  const previousFetch = globalThis.fetch;
  let requestBody: unknown;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(`${init?.body ?? "null"}`);
    return new Response(
      JSON.stringify({
        challenge_id: "challenge-1",
        poll_token: "poll-token",
        approval_url: "https://cocalc.test/auth/cli-login/challenge-1",
        expires_at: "2099-01-01T00:00:00.000Z",
      }),
      { status: 200 },
    );
  };

  try {
    await startLoginChallenge({
      site: normalizeSiteUrl("https://cocalc.test"),
      email: "  user@example.com  ",
    });
    assert.deepEqual(requestBody, {
      email: "user@example.com",
      client_kind: "mobile",
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("continues the same approval challenge after a suspended-browser network timeout", async () => {
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    if (++calls === 1) throw new TypeError("Network request timed out");
    return new Response(
      JSON.stringify({
        state: "approved",
        redeem_token: "redeem",
        expires_at: "2099-01-01",
      }),
    );
  };
  try {
    const { waitForLoginApproval } = await import("./challenge");
    const result = await waitForLoginApproval({
      site: normalizeSiteUrl("https://cocalc.test"),
      challenge: {
        challenge_id: "same",
        poll_token: "poll",
        approval_url: "https://cocalc.test",
        expires_at: "2099-01-01",
      },
      pollIntervalMs: 0,
    });
    assert.equal(result.redeem_token, "redeem");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
