/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const mockAccess = jest.fn();
const mockLogin = jest.fn();

jest.mock("node:fs/promises", () => ({
  access: (...args) => mockAccess(...args),
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

const originalRoot = process.env.COCALC_MANAGED_HARNESSES;
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  process.env.COCALC_MANAGED_HARNESSES = "/test/harnesses";
});
afterEach(() => {
  if (originalRoot === undefined) delete process.env.COCALC_MANAGED_HARNESSES;
  else process.env.COCALC_MANAGED_HARNESSES = originalRoot;
});

const supported =
  process.platform === "linux" && ["x64", "arm64"].includes(process.arch);
const linuxTest = supported ? test : test.skip;

linuxTest(
  "login selects the patched installation, not the upstream version path",
  async () => {
    mockAccess.mockResolvedValue(undefined);
    const { getClaudeSubscriptionLoginService } =
      await import("./claude-subscription-service");
    await getClaudeSubscriptionLoginService();
    expect(mockLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        cliPath: expect.stringMatching(
          /^\/test\/harnesses\/claude-code\/0\.81\.1-r1\/app\/node_modules\/@anthropic-ai\/claude-agent-sdk-linux-(x64|arm64)(-musl)?\/claude$/,
        ),
      }),
    );
  },
);

linuxTest(
  "missing patched installation does not fall back to the old harness",
  async () => {
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    const { getClaudeSubscriptionLoginService } =
      await import("./claude-subscription-service");
    await expect(getClaudeSubscriptionLoginService()).rejects.toThrow("ENOENT");
    expect(mockAccess).toHaveBeenCalledTimes(1);
    expect(mockLogin).not.toHaveBeenCalled();
  },
);
