/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const mockAccess = jest.fn();
const mockRealpath = jest.fn();
const mockLogin = jest.fn();

jest.mock("node:fs/promises", () => ({
  access: (...args) => mockAccess(...args),
  realpath: (...args) => mockRealpath(...args),
}));
jest.mock("./claude-subscription-login", () => ({
  ClaudeSubscriptionLoginService: function (options) {
    mockLogin(options);
  },
}));
jest.mock("./claude-subscription-registry", () => ({
  getClaudeSubscriptionCredential: jest.fn(),
  publishClaudeSubscriptionToken: jest.fn(),
}));
jest.mock("./claude-login-cleanup", () => ({
  reapAbandonedClaudeLogins: jest.fn(),
}));

const originalTools = process.env.COCALC_PROJECT_TOOLS;
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  process.env.COCALC_PROJECT_TOOLS = "/test/tools/current";
  // The live tools alias resolves to a concrete, immutable version.
  mockRealpath.mockImplementation(async (path: string) =>
    path.replace("/test/tools/current", "/test/tools/v9"),
  );
});
afterEach(() => {
  if (originalTools === undefined) delete process.env.COCALC_PROJECT_TOOLS;
  else process.env.COCALC_PROJECT_TOOLS = originalTools;
});

const supported =
  process.platform === "linux" && ["x64", "arm64"].includes(process.arch);
const linuxTest = supported ? test : test.skip;

linuxTest(
  "login runs the claude CLI from the host's installed tools",
  async () => {
    mockAccess.mockResolvedValue(undefined);
    const { getClaudeSubscriptionLoginService } =
      await import("./claude-subscription-service");
    await getClaudeSubscriptionLoginService();
    expect(mockLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        cliPath: "/test/tools/v9/claude-code/bin/claude",
      }),
    );
  },
);

linuxTest(
  "a host without Claude Code in its tools says so plainly",
  async () => {
    mockRealpath.mockRejectedValue(new Error("ENOENT"));
    const { getClaudeSubscriptionLoginService } =
      await import("./claude-subscription-service");
    await expect(getClaudeSubscriptionLoginService()).rejects.toThrow(
      "Claude Code is not installed on this project host yet",
    );
    expect(mockLogin).not.toHaveBeenCalled();
  },
);
