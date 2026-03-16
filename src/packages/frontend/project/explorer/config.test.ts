describe("explorer config persistence", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("reinitializes the DKV handle when the account id changes", async () => {
    const waitForPersistAccountId = jest
      .fn()
      .mockResolvedValueOnce("account-1")
      .mockResolvedValueOnce("account-2");
    const getPersistAccountId = jest
      .fn()
      .mockReturnValueOnce("account-1")
      .mockReturnValueOnce("account-2")
      .mockReturnValue("account-2");
    const dkv = jest
      .fn()
      .mockResolvedValueOnce({
        get: () => undefined,
        set: jest.fn(),
        close: jest.fn(),
      })
      .mockResolvedValueOnce({
        get: () => undefined,
        set: jest.fn(),
        close: jest.fn(),
      });

    jest.doMock("./persist-account-id", () => ({
      getPersistAccountId,
      waitForPersistAccountId,
    }));
    jest.doMock("@cocalc/frontend/webapp-client", () => ({
      webapp_client: {
        conat_client: {
          dkv,
        },
      },
    }));

    await jest.isolateModulesAsync(async () => {
      const { getSortAsync } = await import("./config");

      await getSortAsync({ project_id: "project-1", path: "/alpha" });
      await getSortAsync({ project_id: "project-1", path: "/beta" });
    });

    expect(waitForPersistAccountId).toHaveBeenCalled();
    expect(dkv).toHaveBeenNthCalledWith(1, {
      name: "cocalc-explorer-config",
      account_id: "account-1",
    });
    expect(dkv).toHaveBeenNthCalledWith(2, {
      name: "cocalc-explorer-config",
      account_id: "account-2",
    });
  });
});
