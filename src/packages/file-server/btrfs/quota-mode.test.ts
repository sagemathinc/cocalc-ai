describe("btrfs quota mode reconciliation", () => {
  const originalQuotaMode = process.env.COCALC_BTRFS_QUOTA_MODE;
  const originalDisableQuotas = process.env.COCALC_DISABLE_BTRFS_QUOTAS;
  const originalUnsupportedMode =
    process.env.COCALC_BTRFS_UNSUPPORTED_QUOTA_MODE;
  const originalCacheMs = process.env.COCALC_BTRFS_QUOTA_MODE_CACHE_MS;

  beforeEach(() => {
    jest.resetModules();
    delete process.env.COCALC_DISABLE_BTRFS_QUOTAS;
    delete process.env.COCALC_BTRFS_QUOTA_MODE;
    delete process.env.COCALC_BTRFS_QUOTA_MODE_CACHE_MS;
    delete process.env.COCALC_BTRFS_UNSUPPORTED_QUOTA_MODE;
  });

  afterAll(() => {
    if (originalQuotaMode == null) {
      delete process.env.COCALC_BTRFS_QUOTA_MODE;
    } else {
      process.env.COCALC_BTRFS_QUOTA_MODE = originalQuotaMode;
    }
    if (originalDisableQuotas == null) {
      delete process.env.COCALC_DISABLE_BTRFS_QUOTAS;
    } else {
      process.env.COCALC_DISABLE_BTRFS_QUOTAS = originalDisableQuotas;
    }
    for (const [name, value] of [
      ["COCALC_BTRFS_UNSUPPORTED_QUOTA_MODE", originalUnsupportedMode],
      ["COCALC_BTRFS_QUOTA_MODE_CACHE_MS", originalCacheMs],
    ] as const) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("parses disabled, legacy qgroup, and simple quota status output", async () => {
    const { parseBtrfsQuotaStatus } = await import("./quota-mode");

    expect(
      parseBtrfsQuotaStatus(`
Quotas on /mnt/test:
  Enabled:                 no
`),
    ).toEqual({
      enabled: false,
      mode: "disabled",
    });

    expect(
      parseBtrfsQuotaStatus(`
Quotas on /mnt/test:
  Enabled:                 yes
  Mode:                    qgroup (full accounting)
`),
    ).toEqual({
      enabled: true,
      mode: "legacy-qgroup",
    });

    expect(
      parseBtrfsQuotaStatus(`
Quotas on /mnt/test:
  Enabled:                 yes
  Mode:                    squota (simple accounting)
`),
    ).toEqual({
      enabled: true,
      mode: "simple",
    });
  });

  it("switches an already-enabled filesystem from legacy qgroups to simple", async () => {
    process.env.COCALC_BTRFS_QUOTA_MODE = "simple";
    const readFileMock = jest.fn(async (path: string) => {
      if (path.endsWith("/enabled")) {
        return "1\n";
      }
      if (path.endsWith("/mode")) {
        const count = readFileMock.mock.calls.filter(([value]) =>
          `${value}`.endsWith("/mode"),
        ).length;
        return count === 1 ? "qgroup\n" : "simple\n";
      }
      throw new Error(`unexpected readFile path: ${path}`);
    });
    const btrfsMock = jest.fn(async ({ args }: { args: string[] }) => {
      if (args.join(" ") === "filesystem show /mnt/test") {
        return {
          exit_code: 0,
          stdout: "Label: none  uuid: 11111111-2222-4333-8444-555555555555\n",
          stderr: "",
        };
      }
      if (args.join(" ") === "quota disable /mnt/test") {
        return { exit_code: 0, stdout: "", stderr: "" };
      }
      if (args.join(" ") === "quota enable --simple /mnt/test") {
        return { exit_code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected btrfs args: ${args.join(" ")}`);
    });

    jest.doMock("./util", () => ({
      btrfs: (opts: { args: string[] }) => btrfsMock(opts),
    }));
    jest.doMock("node:fs/promises", () => ({
      readFile: (path: string, encoding: string) =>
        readFileMock(path, encoding),
    }));

    const { ensureBtrfsQuotaMode } = await import("./quota-mode");
    await expect(ensureBtrfsQuotaMode("/mnt/test")).resolves.toEqual({
      enabled: true,
      mode: "simple",
    });

    expect(btrfsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["quota", "disable", "/mnt/test"],
      }),
    );
    expect(btrfsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["quota", "enable", "--simple", "/mnt/test"],
      }),
    );
  });

  it("collapses and caches repeated quota mode reconciliation", async () => {
    process.env.COCALC_BTRFS_QUOTA_MODE = "simple";
    const readFileMock = jest.fn(async (path: string) => {
      if (path.endsWith("/enabled")) {
        return "1\n";
      }
      if (path.endsWith("/mode")) {
        return "simple\n";
      }
      throw new Error(`unexpected readFile path: ${path}`);
    });
    const btrfsMock = jest.fn(async ({ args }: { args: string[] }) => {
      if (args.join(" ") === "filesystem show /mnt/test") {
        return {
          exit_code: 0,
          stdout: "Label: none  uuid: 11111111-2222-4333-8444-555555555555\n",
          stderr: "",
        };
      }
      throw new Error(`unexpected btrfs args: ${args.join(" ")}`);
    });

    jest.doMock("./util", () => ({
      btrfs: (opts: { args: string[] }) => btrfsMock(opts),
    }));
    jest.doMock("node:fs/promises", () => ({
      readFile: (path: string, encoding: string) =>
        readFileMock(path, encoding),
    }));

    const { ensureBtrfsQuotaMode } = await import("./quota-mode");
    await Promise.all([
      ensureBtrfsQuotaMode("/mnt/test"),
      ensureBtrfsQuotaMode("/mnt/test"),
    ]);
    await ensureBtrfsQuotaMode("/mnt/test");

    expect(btrfsMock).toHaveBeenCalledTimes(1);
  });

  function mockKernelWithoutSimpleQuotas(
    enableError: string,
    { featureAdvertised = false } = {},
  ) {
    const btrfsMock = jest.fn(async ({ args }: { args: string[] }) => {
      if (args.join(" ") === "filesystem show /mnt/test") {
        return {
          exit_code: 0,
          stdout: "Label: none  uuid: 11111111-2222-4333-8444-555555555555\n",
          stderr: "",
        };
      }
      if (args.join(" ") === "quota enable --simple /mnt/test") {
        throw new Error(
          `command 'sudo' (args=-n cocalc-runtime-storage btrfs quota enable --simple /mnt/test) exited with nonzero code 1 -- stderr='${enableError}'`,
        );
      }
      throw new Error(`unexpected btrfs args: ${args.join(" ")}`);
    });
    jest.doMock("./util", () => ({
      btrfs: (opts: { args: string[] }) => btrfsMock(opts),
    }));
    jest.doMock("node:fs/promises", () => ({
      readFile: async (path: string) => {
        if (path.endsWith("/enabled")) return "0\n";
        if (path === "/sys/fs/btrfs/features/simple_quota") {
          if (featureAdvertised) return "0\n";
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        throw new Error(`unexpected readFile path: ${path}`);
      },
    }));
    return btrfsMock;
  }

  it("runs without quotas where allowed when the kernel lacks simple quotas", async () => {
    process.env.COCALC_BTRFS_UNSUPPORTED_QUOTA_MODE = "disabled";
    mockKernelWithoutSimpleQuotas(
      "ERROR: quota command failed: Invalid argument",
    );
    const { ensureBtrfsQuotaMode } = await import("./quota-mode");
    await expect(ensureBtrfsQuotaMode("/mnt/test")).resolves.toEqual({
      enabled: false,
      mode: "disabled",
    });
    const { btrfsQuotasDisabled } = await import("./config");
    expect(btrfsQuotasDisabled()).toBe(true);
  });

  it("fails on other hosts when the kernel lacks simple quotas", async () => {
    mockKernelWithoutSimpleQuotas(
      "ERROR: quota command failed: Invalid argument",
    );
    const { ensureBtrfsQuotaMode } = await import("./quota-mode");
    await expect(ensureBtrfsQuotaMode("/mnt/test")).rejects.toThrow(
      "Invalid argument",
    );
    const { btrfsQuotasDisabled } = await import("./config");
    expect(btrfsQuotasDisabled()).toBe(false);
  });

  it("does not hide other quota failures", async () => {
    process.env.COCALC_BTRFS_UNSUPPORTED_QUOTA_MODE = "disabled";
    mockKernelWithoutSimpleQuotas(
      "ERROR: quota command failed: Device or resource busy",
    );
    const { ensureBtrfsQuotaMode } = await import("./quota-mode");
    await expect(ensureBtrfsQuotaMode("/mnt/test")).rejects.toThrow(
      "Device or resource busy",
    );
  });

  it("does not fall back when the kernel advertises simple quotas", async () => {
    process.env.COCALC_BTRFS_UNSUPPORTED_QUOTA_MODE = "disabled";
    mockKernelWithoutSimpleQuotas(
      "ERROR: quota command failed: Invalid argument",
      { featureAdvertised: true },
    );
    const { ensureBtrfsQuotaMode } = await import("./quota-mode");
    await expect(ensureBtrfsQuotaMode("/mnt/test")).rejects.toThrow(
      "Invalid argument",
    );
    const { btrfsQuotasDisabled } = await import("./config");
    expect(btrfsQuotasDisabled()).toBe(false);
  });
});
