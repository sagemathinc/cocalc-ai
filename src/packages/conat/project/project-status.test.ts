describe("project-status explicit routing", () => {
  it("requires an explicit Conat client for get", async () => {
    const { get } = await import("./project-status");

    await expect(
      get({
        project_id: "00000000-1000-4000-8000-000000000000",
      } as any),
    ).rejects.toThrow("must provide an explicit Conat client");
  });

  it("publishes status updates with an explicit client", async () => {
    const { createPublisher } = await import("./project-status");
    const publishSync = jest.fn();
    const projectStatusServer = {
      on: jest.fn((event, cb) => {
        expect(event).toBe("status");
        cb({ state: "running" });
      }),
    };

    await createPublisher({
      client: { publishSync } as any,
      project_id: "00000000-1000-4000-8000-000000000000",
      projectStatusServer,
    });

    expect(publishSync).toHaveBeenCalledWith(
      "project.00000000-1000-4000-8000-000000000000.project-status.-",
      { state: "running" },
    );
  });
});
