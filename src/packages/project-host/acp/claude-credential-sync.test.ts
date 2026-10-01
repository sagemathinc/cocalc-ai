/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createClaudeCredentialSync } from "./claude-credential-sync";
import { packClaudeSubscriptionBundle } from "./claude-subscription-home";

jest.mock("@cocalc/backend/logger", () => () => ({ warn: jest.fn() }));
jest.mock("./claude-subscription-registry", () => ({
  syncClaudeSubscriptionCredential: jest.fn(),
  finalizeClaudeSubscriptionCredential: jest.fn(),
}));

const files = (token: string) =>
  new Map([[".credentials.json", Buffer.from(token)]]);

function setup({
  sync,
  read = jest.fn(async () => files("refresh-token-2")),
}: {
  sync: jest.Mock;
  read?: jest.Mock;
}) {
  return {
    read,
    credentialSync: createClaudeCredentialSync({
      projectId: "00000000-0000-4000-8000-000000000001",
      accountId: "00000000-0000-4000-8000-000000000002",
      credentialId: "00000000-0000-4000-8000-000000000003",
      home: "/controller-home",
      restoredPayload: packClaudeSubscriptionBundle(files("refresh-token-1")),
      finalRetryDelaysMs: [1, 1],
      intervalMs: 10,
      read,
      sync,
    }),
  };
}

test("the final sync snapshots once and retries from memory", async () => {
  const sync = jest
    .fn()
    .mockRejectedValueOnce(Error("hub unavailable"))
    .mockImplementation(async ({ current }) => current);
  const { credentialSync, read } = setup({ sync });
  await credentialSync.finish();
  expect(read).toHaveBeenCalledTimes(1);
  expect(sync).toHaveBeenCalledTimes(2);
  expect(`${sync.mock.calls[1][0].current.get(".credentials.json")}`).toBe(
    "refresh-token-2",
  );
});

test("a later cleanup retry syncs from the snapshot after the home is gone", async () => {
  const sync = jest.fn().mockRejectedValue(Error("hub unavailable"));
  const { credentialSync, read } = setup({ sync });
  await expect(credentialSync.finish()).rejects.toThrow("hub unavailable");
  expect(sync).toHaveBeenCalledTimes(3);
  // The home is removed; reading it again would fail.
  read.mockRejectedValue(Error("home removed"));
  sync.mockImplementation(async ({ current }) => current);
  await credentialSync.finish();
  expect(read).toHaveBeenCalledTimes(1);
  expect(`${sync.mock.lastCall[0].current.get(".credentials.json")}`).toBe(
    "refresh-token-2",
  );
});

test("periodic syncs run while started and stop when idle", async () => {
  const sync = jest.fn(async ({ current }) => current);
  const { credentialSync } = setup({ sync });
  credentialSync.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await credentialSync.idle();
  const calls = sync.mock.calls.length;
  expect(calls).toBeGreaterThan(0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(sync.mock.calls.length).toBe(calls);
});

test("owned final cleanup is write-only even when ordinary credential access was removed", async () => {
  const sync = jest.fn().mockRejectedValue(Error("collaborator removed"));
  const finalize = jest
    .fn()
    .mockRejectedValueOnce(Error("ack lost"))
    .mockImplementation(async ({ current }) => current);
  const read = jest.fn(async () => files("final-rotation"));
  const restoredPayload = packClaudeSubscriptionBundle(files("original"));
  const credentialSync = createClaudeCredentialSync({
    projectId: "project",
    accountId: "account",
    credentialId: "credential",
    controllerHolder: "holder",
    home: "/private-home",
    restoredPayload,
    intervalMs: 5,
    finalRetryDelaysMs: [1],
    read,
    sync,
    finalize,
  });
  credentialSync.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await credentialSync.idle();
  expect(sync).toHaveBeenCalled();
  sync.mockClear();
  await credentialSync.finish();
  expect(sync).not.toHaveBeenCalled();
  expect(finalize).toHaveBeenCalledTimes(2);
  expect(finalize.mock.calls[0][0].expectedPayload).toBe(restoredPayload);
  expect(
    finalize.mock.calls[1][0].current.get(".credentials.json").toString(),
  ).toBe("final-rotation");
});
