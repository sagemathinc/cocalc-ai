describe("project usage-info explicit routing", () => {
  it("requires an explicit Conat client for get", async () => {
    const { get } = await import("./usage-info");

    await expect(
      get({
        project_id: "00000000-1000-4000-8000-000000000000",
        path: "notebook.ipynb",
      }),
    ).rejects.toThrow("must provide an explicit Conat client");
  });

  it("creates the service with an explicit client", async () => {
    const { createUsageInfoService } = await import("./usage-info");
    const close = jest.fn();
    const client = {
      service: jest.fn().mockResolvedValue({ close }),
    } as any;

    const service = createUsageInfoService({
      project_id: "00000000-1000-4000-8000-000000000000",
      client,
      createUsageInfoServer: () => ({
        on: jest.fn(),
        close: jest.fn(),
      }),
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(client.service).toHaveBeenCalledWith(
      "project.00000000-1000-4000-8000-000000000000.usage-info.-",
      expect.objectContaining({
        get: expect.any(Function),
      }),
    );

    service.close();
  });
});
