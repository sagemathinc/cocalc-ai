/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const assertAiLaunchAllowedMock = jest.fn();
const createCodexAgentMock = jest.fn();

jest.mock("@cocalc/server/launch/kill-switches", () => ({
  assertAiLaunchAllowed: (...args: any[]) => assertAiLaunchAllowedMock(...args),
}));

jest.mock("@cocalc/ai/acp", () => ({
  CodexAppServerAgent: {
    create: (...args: any[]) => createCodexAgentMock(...args),
  },
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

describe("agent launch kill switches", () => {
  beforeEach(() => {
    jest.resetModules();
    assertAiLaunchAllowedMock.mockReset();
    createCodexAgentMock.mockReset();
  });

  it("blocks planner Codex work when AI is disabled", async () => {
    assertAiLaunchAllowedMock.mockRejectedValue(
      new Error("AI and Codex are temporarily disabled"),
    );

    const { plan } = await import("./agent");

    await expect(
      plan({
        account_id: "11111111-1111-4111-8111-111111111111",
        prompt: "create a project",
      }),
    ).rejects.toThrow("AI and Codex are temporarily disabled");
    expect(assertAiLaunchAllowedMock).toHaveBeenCalledTimes(1);
    expect(createCodexAgentMock).not.toHaveBeenCalled();
  });
});
