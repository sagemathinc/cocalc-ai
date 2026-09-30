jest.mock("./binary-integrity", () => ({ matchesBinarySha256: jest.fn() }));
jest.mock("fs/promises", () => ({
  ...jest.requireActual("fs/promises"),
  stat: jest.fn().mockResolvedValue({}),
}));
jest.mock("@cocalc/backend/execute-code", () => ({
  executeCode: jest
    .fn()
    .mockResolvedValue({ stdout: "codex-cli 0.159.2", stderr: "" }),
}));

describe.each(["x64", "arm64"])("patched Codex identity (%s)", (arch) => {
  const original = process.env.COCALC_TOOL_ARCH;
  beforeEach(() => {
    jest.resetModules();
    process.env.COCALC_TOOL_ARCH = arch;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.COCALC_TOOL_ARCH;
    else process.env.COCALC_TOOL_ARCH = original;
  });

  it("accepts only a verified matched set, including cross-builds", async () => {
    const { matchesBinarySha256 } = require("./binary-integrity");
    matchesBinarySha256.mockResolvedValue(true);
    const { alreadyInstalled, SPEC } = require("./install");
    expect(await alreadyInstalled("codex")).toBe(true);
    expect(matchesBinarySha256).toHaveBeenCalledTimes(3);
    expect(matchesBinarySha256.mock.calls[0][0]).toMatch(
      /codex-code-mode-host$/,
    );
    expect(matchesBinarySha256.mock.calls[1][0]).toMatch(
      /codex-resources\/bwrap$/,
    );
    expect(matchesBinarySha256.mock.calls[2][0]).toMatch(/\/codex$/);
    expect(SPEC.codex.script()).toContain(`linux-${arch}.xz`);
  });

  it("rejects a same-version stock CLI before running it", async () => {
    const { matchesBinarySha256 } = require("./binary-integrity");
    matchesBinarySha256.mockImplementation(
      async (path: string) => !path.endsWith("/codex"),
    );
    const { alreadyInstalled } = require("./install");
    expect(await alreadyInstalled("codex")).toBe(false);
    expect(
      require("@cocalc/backend/execute-code").executeCode,
    ).not.toHaveBeenCalled();
  });

  it.each(["codex-code-mode-host", "bwrap", "codex"])(
    "rejects a missing or mismatched %s",
    async (binary) => {
      const { matchesBinarySha256 } = require("./binary-integrity");
      matchesBinarySha256.mockImplementation(
        async (path: string) => !path.endsWith(`/${binary}`),
      );
      const { alreadyInstalled } = require("./install");
      expect(await alreadyInstalled("codex")).toBe(false);
    },
  );
});
