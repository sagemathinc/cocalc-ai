describe("time explicit client registration", () => {
  const originalTestMode = process.env.COCALC_TEST_MODE;
  const originalProjectId = process.env.COCALC_PROJECT_ID;

  beforeEach(() => {
    jest.resetModules();
    delete process.env.COCALC_TEST_MODE;
    delete process.env.COCALC_PROJECT_ID;
  });

  afterEach(async () => {
    if (originalTestMode == null) {
      delete process.env.COCALC_TEST_MODE;
    } else {
      process.env.COCALC_TEST_MODE = originalTestMode;
    }
    if (originalProjectId == null) {
      delete process.env.COCALC_PROJECT_ID;
    } else {
      process.env.COCALC_PROJECT_ID = originalProjectId;
    }
    jest.resetModules();
  });

  it("uses the registered runtime client factory instead of importing the global client", async () => {
    const timeRequest = jest.fn(async () => Date.now());
    const timeClient = jest.fn(() => ({ time: timeRequest }));

    jest.doMock("@cocalc/conat/client", () => {
      throw new Error("time.ts must not import @cocalc/conat/client");
    });
    jest.doMock("@cocalc/conat/service/time", () => ({
      timeClient,
    }));

    const time = await import("./time");

    const conatClient = { id: "core-client" } as any;
    time.setConatTimeClientFactory(() => ({
      conat: () => conatClient,
      account_id: "acct-1",
      project_id: "project-1",
      state: "connected",
    }));

    await expect(time.getSkew()).resolves.toEqual(expect.any(Number));
    expect(timeClient).toHaveBeenCalledWith({
      client: conatClient,
      account_id: "acct-1",
      project_id: "project-1",
    });

    time.close();
    time.setConatTimeClientFactory(undefined);
  });
});
