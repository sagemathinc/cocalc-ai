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
    const btrfsMock = jest.fn(async ({ args }: { args: string[] }) => {
      if (args.join(" ") === "quota status /mnt/test") {
        const count = btrfsMock.mock.calls.filter(
          ([call]) => call.args.join(" ") === "quota status /mnt/test",
        ).length;
        if (count === 1) {
          return {
            exit_code: 0,
            stdout: `
Quotas on /mnt/test:
  Enabled:                 yes
  Mode:                    qgroup (full accounting)
`,
            stderr: "",
          };
        }
        return {
          exit_code: 0,
          stdout: `
Quotas on /mnt/test:
  Enabled:                 yes
  Mode:                    squota (simple accounting)
`,
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
