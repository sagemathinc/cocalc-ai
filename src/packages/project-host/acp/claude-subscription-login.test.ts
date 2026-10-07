/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { join } from "node:path";
import {
  ClaudeSubscriptionLoginService,
  terminalText,
} from "./claude-subscription-login";

const accountId = "d62ec7c2-7b5a-49b7-9662-5c280bbac40b";
const otherAccountId = "fca177c1-b1d6-4f85-bd89-0afc61f67ed8";
const projectId = "3807103b-f2f9-4ced-8885-eeb442d623b7";
const credentialId = "02bfd0a0-50f1-4378-a7fd-bf87a12a2860";
const fixture = join(__dirname, "fixtures", "claude-login.cjs");
const echoFixture = join(__dirname, "fixtures", "claude-login-echo.cjs");
const fixtureToken = `sk-ant-oat01-${"Fixture_token-0123456789".repeat(3)}`;

async function verificationUrl(
  service: ClaudeSubscriptionLoginService,
  id: string,
): Promise<string> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const url = service.status(id, projectId, accountId).verificationUrl;
    if (url) return url;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error("provider URL was not reported");
}

async function waitFor(
  service: ClaudeSubscriptionLoginService,
  id: string,
  state: string,
): Promise<ReturnType<typeof service.status>> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const current = service.status(id, projectId, accountId);
    if (current.state === state) return current;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error(`Claude login did not reach ${state}`);
}

test("reconnect validates the credential and replaces its token in place", async () => {
  const publish = jest.fn(async () => credentialId);
  const validateReconnect = jest.fn(async () => ({}));
  const service = new ClaudeSubscriptionLoginService({
    cliPath: process.execPath,
    argsPrefix: [fixture],
    publish,
    validateReconnect,
  });
  try {
    const started = await service.start(projectId, accountId, credentialId);
    expect(validateReconnect).toHaveBeenCalledWith({
      projectId,
      accountId,
      credentialId,
    });
    await verificationUrl(service, started.id);
    service.submitCode(started.id, projectId, accountId, "fixture-code");
    const status = await waitFor(service, started.id, "completed");
    expect(status.credentialId).toBe(credentialId);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ credentialId, token: fixtureToken }),
    );
  } finally {
    await service.close();
  }
});

test("a new sign-in replaces an abandoned pending one", async () => {
  const publish = jest.fn(async () => credentialId);
  const service = new ClaudeSubscriptionLoginService({
    cliPath: process.execPath,
    argsPrefix: [fixture],
    publish,
  });
  try {
    const first = await service.start(projectId, accountId);
    await verificationUrl(service, first.id);
    const second = await service.start(projectId, accountId);
    expect(second.id).not.toBe(first.id);
    expect(service.status(first.id, projectId, accountId).state).toBe(
      "canceled",
    );
    await verificationUrl(service, second.id);
    service.submitCode(second.id, projectId, accountId, "fixture-code");
    await waitFor(service, second.id, "completed");
  } finally {
    await service.close();
  }
});

test("reconnect rejects unavailable credentials before starting sign-in", async () => {
  const publish = jest.fn();
  const service = new ClaudeSubscriptionLoginService({
    cliPath: process.execPath,
    argsPrefix: [fixture],
    publish,
    validateReconnect: async () => {
      throw Error("unavailable");
    },
  });
  try {
    await expect(
      service.start(projectId, accountId, credentialId),
    ).rejects.toThrow("unavailable");
    expect(publish).not.toHaveBeenCalled();
  } finally {
    await service.close();
  }
});

test("sign-in runs setup-token in a terminal, accepts one code and saves only the token", async () => {
  const publish = jest.fn(
    async (_options: {
      projectId: string;
      accountId: string;
      token: string;
      expiresAt: string;
    }) => credentialId,
  );
  const service = new ClaudeSubscriptionLoginService({
    cliPath: process.execPath,
    argsPrefix: [fixture],
    publish,
  });
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "must-not-inherit";
  try {
    const started = await service.start(projectId, accountId);
    expect(started.state).toBe("pending");
    expect(await verificationUrl(service, started.id)).toBe(
      "https://claude.com/cai/oauth/authorize?code=true&scope=user%3Ainference&state=fixture",
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
    expect(publish).toHaveBeenCalledTimes(1);
    const published = publish.mock.calls[0][0];
    expect(published).toMatchObject({
      projectId,
      accountId,
      token: fixtureToken,
    });
    // About a year from now.
    expect(Date.parse(published.expiresAt) - Date.now()).toBeGreaterThan(
      360 * 24 * 3600 * 1000,
    );
    expect(() => service.cancel(started.id, projectId, accountId)).toThrow(
      "already completed",
    );
  } finally {
    if (previousKey == null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    await service.close();
  }
});

test("a rejected code fails promptly instead of waiting for a retry", async () => {
  const publish = jest.fn();
  const service = new ClaudeSubscriptionLoginService({
    cliPath: process.execPath,
    argsPrefix: [fixture],
    publish,
  });
  try {
    const started = await service.start(projectId, accountId);
    await verificationUrl(service, started.id);
    service.submitCode(started.id, projectId, accountId, "wrong-code");
    const failed = await waitFor(service, started.id, "failed");
    expect(failed.error).toBe(
      "Claude did not accept the code. Copy the whole code and try again.",
    );
    expect(publish).not.toHaveBeenCalled();
  } finally {
    await service.close();
  }
});

test("a full-length pasted code is submitted with a separate Enter", async () => {
  const publish = jest.fn(async () => credentialId);
  const service = new ClaudeSubscriptionLoginService({
    cliPath: process.execPath,
    argsPrefix: [fixture],
    publish,
    enterDelayMs: 100,
  });
  try {
    const started = await service.start(projectId, accountId);
    await verificationUrl(service, started.id);
    // Real codes are about 100 characters: the CLI sees them as a paste.
    service.submitCode(
      started.id,
      projectId,
      accountId,
      ` fixture-code#${"s".repeat(100)}\n`.trim(),
    );
    await waitFor(service, started.id, "completed");
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ token: fixtureToken }),
    );
  } finally {
    await service.close();
  }
});

test("a pasted token is refused, and echoed input is never saved as one", async () => {
  const publish = jest.fn(async () => credentialId);
  const service = new ClaudeSubscriptionLoginService({
    cliPath: process.execPath,
    argsPrefix: [echoFixture],
    publish,
    enterDelayMs: 50,
    exchangeTimeoutMs: 1_000,
  });
  try {
    const started = await service.start(projectId, accountId);
    await verificationUrl(service, started.id);
    expect(() =>
      service.submitCode(started.id, projectId, accountId, fixtureToken),
    ).toThrow("That is a Claude token, not a sign-in code.");
    expect(service.status(started.id, projectId, accountId).state).toBe(
      "pending",
    );
    // The CLI echoes and redraws this code but never returns a token.
    service.submitCode(
      started.id,
      projectId,
      accountId,
      `fixture-code#${"s".repeat(100)}`,
    );
    const failed = await waitFor(service, started.id, "failed");
    expect(failed.error).toBe(
      "Claude did not finish signing in. Start the sign-in again.",
    );
    expect(publish).not.toHaveBeenCalled();
  } finally {
    await service.close();
  }
});

test("a code exchange that never finishes fails instead of spinning forever", async () => {
  const publish = jest.fn();
  const service = new ClaudeSubscriptionLoginService({
    cliPath: process.execPath,
    argsPrefix: [fixture],
    publish,
    enterDelayMs: 50,
    exchangeTimeoutMs: 500,
  });
  try {
    const started = await service.start(projectId, accountId);
    await verificationUrl(service, started.id);
    service.submitCode(started.id, projectId, accountId, "fixture-hang");
    const failed = await waitFor(service, started.id, "failed");
    expect(failed.error).toBe(
      "Claude did not finish signing in. Start the sign-in again.",
    );
    expect(publish).not.toHaveBeenCalled();
  } finally {
    await service.close();
  }
});

test("terminal output becomes plain text with spaces for cursor moves", () => {
  const ESC = String.fromCharCode(27);
  expect(
    terminalText(
      `${ESC}[2mOAuth${ESC}[1Cerror${ESC}[22m\r\n${ESC}]0;title\u0007x`,
    ),
  ).toBe("OAuth error\nx");
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
  try {
    const started = await service.start(projectId, accountId);
    await verificationUrl(service, started.id);
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
  } finally {
    await service.close();
  }
});

test("shutdown cancels pending sign-in and rejects new login attempts", async () => {
  const publish = jest.fn();
  const service = new ClaudeSubscriptionLoginService({
    cliPath: process.execPath,
    argsPrefix: [fixture],
    publish,
  });
  const started = await service.start(projectId, accountId);
  await service.close();
  expect(publish).not.toHaveBeenCalled();
  expect(() => service.status(started.id, projectId, accountId)).toThrow(
    "Unknown",
  );
  await expect(service.start(projectId, accountId)).rejects.toThrow("closed");
});
