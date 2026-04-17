describe("btrfs quota mode reconciliation", () => {
  const originalQuotaMode = process.env.COCALC_BTRFS_QUOTA_MODE;
  const originalDisableQuotas = process.env.COCALC_DISABLE_BTRFS_QUOTAS;

  beforeEach(() => {
    jest.resetModules();
    delete process.env.COCALC_DISABLE_BTRFS_QUOTAS;
    delete process.env.COCALC_BTRFS_QUOTA_MODE;
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
  });

  it("parses disabled, qgroup, and simple quota status output", async () => {
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
      mode: "qgroup",
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

  it("switches an already-enabled filesystem from qgroup to simple", async () => {
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
});
