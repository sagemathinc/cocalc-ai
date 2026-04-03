jest.mock("@cocalc/conat/sync/akv", () => ({
  akv: jest.fn(() => ({
    close: jest.fn(),
    get: jest.fn(),
    keys: jest.fn().mockResolvedValue([]),
    set: jest.fn(),
  })),
}));

describe("project-info explicit routing", () => {
  it("requires an explicit Conat client for get", async () => {
    const { get } = await import("./project-info");

    await expect(
      get({
        project_id: "00000000-1000-4000-8000-000000000000",
      } as any),
    ).rejects.toThrow("must provide an explicit Conat client");
  });

  it("requires an explicit Conat client for getHistory", async () => {
    const { getHistory } = await import("./project-info");

    await expect(
      getHistory({
        project_id: "00000000-1000-4000-8000-000000000000",
      } as any),
    ).rejects.toThrow("must provide an explicit Conat client");
  });

  it("creates the service with an explicit client", async () => {
    const { createService } = await import("./project-info");
    const close = jest.fn();
    const client = {
      service: jest.fn().mockResolvedValue({ close }),
    } as any;

    const service = createService({
      infoServer: {
        start: jest.fn(),
        on: jest.fn(),
        noteClientActivity: jest.fn(),
        removeListener: jest.fn(),
      },
      project_id: "00000000-1000-4000-8000-000000000000",
      client,
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(client.service).toHaveBeenCalledWith(
      "project.00000000-1000-4000-8000-000000000000.project-info.-",
      expect.objectContaining({
        get: expect.any(Function),
        getHistory: expect.any(Function),
      }),
    );

    service.close();
  });
});
