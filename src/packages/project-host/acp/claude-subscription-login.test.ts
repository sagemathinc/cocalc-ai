/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  ClaudeSubscriptionLoginService,
  verifiedClaudeSubscriptionStatus,
} from "./claude-subscription-login";

const accountId = "d62ec7c2-7b5a-49b7-9662-5c280bbac40b";
const otherAccountId = "fca177c1-b1d6-4f85-bd89-0afc61f67ed8";
const projectId = "3807103b-f2f9-4ced-8885-eeb442d623b7";
const credentialId = "02bfd0a0-50f1-4378-a7fd-bf87a12a2860";
const fixture = join(__dirname, "fixtures", "claude-login.cjs");

async function waitFor(
  service: ClaudeSubscriptionLoginService,
  id: string,
  state: string,
): Promise<ReturnType<typeof service.status>> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = service.status(id, projectId, accountId);
    if (current.state === state) return current;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error(`Claude login did not reach ${state}`);
}

test("login stages outside projects, accepts one code, verifies and cleans up", async () => {
  let publishedHome: string | undefined;
  const service = new ClaudeSubscriptionLoginService({
    cliPath: process.execPath,
    argsPrefix: [fixture],
    publish: async ({
      projectId: target,
      accountId: owner,
      home,
      identity,
      plan,
    }) => {
      expect(target).toBe(projectId);
      expect(owner).toBe(accountId);
      expect(identity).toBe("subscriber@example.com");
      expect(plan).toBe("max");
      expect((await stat(home)).isDirectory()).toBe(true);
      publishedHome = home;
      return credentialId;
    },
  });
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "must-not-inherit";
  try {
    const started = await service.start(projectId, accountId);
    expect(started.state).toBe("pending");
    const waiting = await (async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const current = service.status(started.id, projectId, accountId);
        if (current.verificationUrl) return current;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw Error("provider URL was not reported");
    })();
    expect(waiting.verificationUrl).toBe(
      "https://claude.com/cai/oauth/authorize?state=fixture",
    );
    expect(() => service.status(started.id, projectId, otherAccountId)).toThrow(
      "Unknown Claude sign-in session",
    );
    service.submitCode(started.id, projectId, accountId, "fixture-code");
    expect(() =>
      service.submitCode(started.id, projectId, accountId, "fixture-code"),
    ).toThrow();
    const completed = await waitFor(service, started.id, "completed");
    expect(completed.credentialId).toBe(credentialId);
    expect(() => service.cancel(started.id, projectId, accountId)).toThrow(
      "already completed",
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        await stat(publishedHome!).then(
          () => false,
          () => true,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await expect(stat(publishedHome!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    if (previousKey == null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

test("status rejects API billing, no plan, and absent identity", () => {
  const valid = {
    loggedIn: true,
    apiProvider: "firstParty",
    subscriptionType: "pro",
    email: "subscriber@example.com",
  };
  expect(verifiedClaudeSubscriptionStatus(JSON.stringify(valid)).plan).toBe(
    "pro",
  );
  for (const override of [
    { apiKeySource: "ANTHROPIC_API_KEY" },
    { subscriptionType: "free" },
    { email: "" },
    { apiProvider: "bedrock" },
    { loggedIn: false },
  ])
    expect(() =>
      verifiedClaudeSubscriptionStatus(
        JSON.stringify({ ...valid, ...override }),
      ),
    ).toThrow();
});

test("verification cannot report cancellation after publication starts", async () => {
  let releasePublish!: () => void;
  let enteredPublish!: () => void;
  const entered = new Promise<void>((resolve) => (enteredPublish = resolve));
  const service = new ClaudeSubscriptionLoginService({
    cliPath: process.execPath,
    argsPrefix: [fixture],
    publish: async () => {
      enteredPublish();
      await new Promise<void>((resolve) => (releasePublish = resolve));
      return credentialId;
    },
  });
  const started = await service.start(projectId, accountId);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (service.status(started.id, projectId, accountId).verificationUrl) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  service.submitCode(started.id, projectId, accountId, "fixture-code");
  try {
    await entered;
    expect(service.status(started.id, projectId, accountId).state).toBe(
      "verifying",
    );
    expect(() => service.cancel(started.id, projectId, accountId)).toThrow(
      "verification is already in progress",
    );
  } finally {
    releasePublish?.();
  }
  expect((await waitFor(service, started.id, "completed")).credentialId).toBe(
    credentialId,
  );
});
