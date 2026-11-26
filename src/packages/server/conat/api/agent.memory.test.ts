/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const withMemoryHomeMock = jest.fn();

jest.mock("@cocalc/server/agents/memory-home", () => ({
  withMemoryHome: (...args: any[]) => withMemoryHomeMock(...args),
}));

jest.mock("@cocalc/ai/acp", () => ({
  CodexAppServerAgent: { create: jest.fn() },
}));

jest.mock("@cocalc/ai/agent-sdk", () => ({
  createLaunchpadAgentSdkBridge: jest.fn(() => ({
    manifest: jest.fn(() => []),
    execute: jest.fn(),
  })),
}));

jest.mock("@cocalc/backend/conat", () => ({
  conat: jest.fn(async () => ({})),
}));

jest.mock("@cocalc/conat/project/api", () => ({
  projectApiClient: jest.fn(),
}));

jest.mock("@cocalc/conat/files/fs", () => ({
  fsClient: jest.fn(),
  fsSubject: jest.fn(),
}));

import { agent as agentTransforms } from "@cocalc/conat/hub/api/agent";
import { validateAgentMemoryCuratorRequest } from "@cocalc/conat/agents/memory";

const account_id = "11111111-1111-4111-8111-111111111111";

// What the hub does with a curateAgentMemory call: bind the caller, then run
// the server method, whose memory home validates the curator request.
async function callThroughHub(
  request: Record<string, unknown>,
  auth_session_hash: string | null,
) {
  const { curateAgentMemory } = await import("./agent");
  const args = await agentTransforms.curateAgentMemory({
    args: [{ ...request }],
    account_id,
    auth_session_hash,
  });
  return await curateAgentMemory(args[0]);
}

describe("curateAgentMemory through the hub transform", () => {
  beforeEach(() => {
    withMemoryHomeMock.mockReset();
    withMemoryHomeMock.mockImplementation(async (_account_id, home) => {
      validateAgentMemoryCuratorRequest(home.request);
      return { ok: true };
    });
  });

  it.each([
    ["a signed-in session", "session-hash"],
    ["an API key (no session)", null],
  ])("lists memory for %s", async (_caller, auth_session_hash) => {
    await expect(
      callThroughHub({ op: "list" }, auth_session_hash),
    ).resolves.toEqual({ ok: true });
    expect(withMemoryHomeMock).toHaveBeenCalledWith(account_id, {
      kind: "curator",
      request: { op: "list" },
    });
  });

  it("still rejects an unknown field the caller sent", async () => {
    await expect(
      callThroughHub({ op: "list", unexpected: true }, "session-hash"),
    ).rejects.toThrow("unknown memory request field");
  });
});
