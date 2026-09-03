/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import assert from "node:assert/strict";
import test from "node:test";

import { requestManagedCodexFreshAuth } from "./codex-fresh-auth";

const ACCOUNT_ID = "00000000-1000-4000-8000-000000000001";
const PROJECT_ID = "00000000-2000-4000-8000-000000000002";
const CHALLENGE_ID = "00000000-3000-4000-8000-000000000003";

function context(overrides: Record<string, unknown> = {}): any {
  return {
    accountId: ACCOUNT_ID,
    pollMs: 1,
    remote: {
      user: {
        auth_actor: "agent",
        auth_project_id: PROJECT_ID,
      },
    },
    hub: {
      notifications: {
        startCodexFreshAuthAction: async () => ({
          challenge_id: CHALLENGE_ID,
          state: "pending",
          expires_at: "2099-09-02T01:00:00.000Z",
        }),
        getCodexFreshAuthActionStatus: async () => ({
          challenge_id: CHALLENGE_ID,
          state: "approved",
          expires_at: "2099-09-02T01:00:00.000Z",
        }),
      },
    },
    ...overrides,
  };
}

function env(): NodeJS.ProcessEnv {
  return {
    COCALC_PROJECT_ID: PROJECT_ID,
    COCALC_BROWSER_ID: "browser-1",
    COCALC_CODEX_CHAT_PATH: "agent.chat",
    COCALC_CODEX_THREAD_ID: "thread-1",
    COCALC_CODEX_TURN_ID: "turn-1",
    COCALC_CODEX_MESSAGE_DATE: "2099-09-02T00:00:00.000Z",
  };
}

test("requests a bound approval and waits for authoritative completion", async () => {
  const ctx = context();
  const output: string[] = [];
  await requestManagedCodexFreshAuth({
    ctx,
    commandName: "host delete",
    env: env(),
    write: (message) => output.push(message),
  });

  assert.equal(output.join("").includes(CHALLENGE_ID), false);
  assert.match(output.join(""), /Approval requested in CoCalc/);
  assert.match(output.join(""), /Retrying action/);
});

test("rejects environment project substitution before requesting approval", async () => {
  let called = false;
  const ctx = context({
    hub: {
      notifications: {
        startCodexFreshAuthAction: async () => {
          called = true;
        },
      },
    },
  });
  await assert.rejects(
    requestManagedCodexFreshAuth({
      ctx,
      commandName: "host delete",
      env: {
        ...env(),
        COCALC_PROJECT_ID: "00000000-9000-4000-8000-000000000009",
      },
    }),
    /does not match agent auth/,
  );
  assert.equal(called, false);
});

test("does not treat a canceled challenge as authorization", async () => {
  const ctx = context();
  ctx.hub.notifications.getCodexFreshAuthActionStatus = async () => ({
    challenge_id: CHALLENGE_ID,
    state: "canceled",
    expires_at: "2099-09-02T01:00:00.000Z",
  });
  await assert.rejects(
    requestManagedCodexFreshAuth({
      ctx,
      commandName: "host delete",
      env: env(),
      write: () => undefined,
    }),
    /canceled/,
  );
});
