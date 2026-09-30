/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedClaudeSubscriptionFiles,
  claudeSubscriptionBundleFiles,
  packClaudeSubscriptionBundle,
  restoreClaudeSubscriptionHome,
} from "./claude-subscription-home";
import { syncClaudeSubscriptionCredential } from "./claude-subscription-registry";
import {
  ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY,
  ACCOUNT_CREDENTIAL_PROFILE_METADATA_KEY,
  CLAUDE_SUBSCRIPTION_PROFILE_ID,
} from "@cocalc/util/ai/external-credential-profiles";

// An in-memory stand-in for the account credential registry.
let stored: string;
const upserts: string[] = [];
const mockCallHub = jest.fn(async ({ name, args }) => {
  if (name === "hosts.getExternalCredential")
    return {
      id: credentialId,
      payload: stored,
      metadata: {
        [ACCOUNT_CREDENTIAL_PROFILE_METADATA_KEY]:
          CLAUDE_SUBSCRIPTION_PROFILE_ID,
        [ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY]: "user@example.com",
        plan: "Claude Max",
      },
    };
  if (name === "hosts.upsertExternalCredential") {
    stored = args[0].payload;
    upserts.push(stored);
    return { id: credentialId };
  }
  throw Error(`unexpected hub call ${name}`);
});
jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: (options) => mockCallHub(options),
}));
jest.mock("../master-conat-client", () => ({
  getMasterConatClient: () => ({}),
}));
jest.mock("../sqlite/hosts", () => ({ getLocalHostId: () => "host" }));

const projectId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";
const credentialId = "00000000-0000-4000-8000-000000000003";

const bundle = (files: Record<string, string>) =>
  packClaudeSubscriptionBundle(
    new Map(
      Object.entries(files).map(([path, text]) => [path, Buffer.from(text)]),
    ),
  );
const text = (payload: string) =>
  Object.fromEntries(
    [...claudeSubscriptionBundleFiles(payload)].map(([path, bytes]) => [
      path,
      bytes.toString(),
    ]),
  );

/** A controller: a private home restored from the stored bundle. */
async function controller() {
  const home = await mkdtemp(join(tmpdir(), "claude-sync-test-"));
  await restoreClaudeSubscriptionHome(home, stored);
  let baseline: ReadonlyMap<string, Buffer> =
    claudeSubscriptionBundleFiles(stored);
  return {
    home,
    write: (path: string, value: string) => writeFile(join(home, path), value),
    sync: async () => {
      baseline = await syncClaudeSubscriptionCredential({
        projectId,
        accountId,
        credentialId,
        home,
        baseline,
      });
    },
    close: () => rm(home, { recursive: true, force: true }),
  };
}

beforeEach(() => {
  upserts.length = 0;
  mockCallHub.mockClear();
  stored = bundle({
    ".credentials.json": "refresh-token-1",
    ".claude.json": "{}",
  });
});

test("an unchanged controller saves nothing", async () => {
  const a = await controller();
  try {
    await a.sync();
    expect(upserts).toEqual([]);
    expect(mockCallHub).not.toHaveBeenCalled();
  } finally {
    await a.close();
  }
});

test("a controller that never refreshed cannot restore a revoked token", async () => {
  const a = await controller();
  const b = await controller();
  try {
    // A refreshes: Claude rotates the refresh token.
    await a.write(".credentials.json", "refresh-token-2");
    await a.sync();
    expect(text(stored)[".credentials.json"]).toBe("refresh-token-2");
    // B, started earlier, only updated its settings/cache file.
    await b.write(".claude.json", '{"numStartups":2}');
    await b.sync();
    expect(text(stored)).toEqual({
      ".credentials.json": "refresh-token-2",
      ".claude.json": '{"numStartups":2}',
    });
  } finally {
    await a.close();
    await b.close();
  }
});

test("each sync saves only what changed since the previous one", async () => {
  const a = await controller();
  try {
    await a.write(".credentials.json", "refresh-token-2");
    await a.sync();
    // Another controller refreshes afterwards.
    stored = bundle({
      ".credentials.json": "refresh-token-3",
      ".claude.json": "{}",
    });
    // A's credentials did not change again, so a later sync keeps token 3.
    await a.write(".claude.json", '{"x":1}');
    await a.sync();
    expect(text(stored)[".credentials.json"]).toBe("refresh-token-3");
    expect(upserts).toHaveLength(2);
  } finally {
    await a.close();
  }
});

test("bundle helpers round-trip and compare opaque bytes", () => {
  const before = claudeSubscriptionBundleFiles(
    bundle({ a: "1", "dir/b": "2" }),
  );
  const after = claudeSubscriptionBundleFiles(bundle({ a: "1", "dir/b": "3" }));
  expect([...changedClaudeSubscriptionFiles(before, after).keys()]).toEqual([
    "dir/b",
  ]);
  expect(changedClaudeSubscriptionFiles(before, before).size).toBe(0);
  expect(() =>
    packClaudeSubscriptionBundle(new Map([["../escape", Buffer.from("x")]])),
  ).toThrow("Invalid Claude auth path");
  expect(() =>
    claudeSubscriptionBundleFiles(
      JSON.stringify({ version: 1, files: [{ path: "a", content: "!!" }] }),
    ),
  ).toThrow("Invalid Claude auth bundle entry");
});
