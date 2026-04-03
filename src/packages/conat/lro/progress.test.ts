describe("lro progress explicit routing", () => {
  it("requires an explicit Conat client", async () => {
    const { lroProgress } = await import("./progress");

    await expect(
      lroProgress({
        op_id: "op-1",
        project_id: "00000000-1000-4000-8000-000000000000",
        phase: "copy",
      }),
    ).rejects.toThrow("must provide an explicit Conat client");
  });

  it("publishes to the explicit client stream", async () => {
    const { lroProgress } = await import("./progress");
    const publish = jest.fn().mockResolvedValue(undefined);
    const client = {
      sync: {
        astream: jest.fn().mockReturnValue({ publish }),
      },
    } as any;

    await expect(
      lroProgress({
        op_id: "op-1",
        project_id: "00000000-1000-4000-8000-000000000000",
        phase: "copy",
        message: "copying",
        progress: 25,
        client,
      }),
    ).resolves.toBeUndefined();

    expect(client.sync.astream).toHaveBeenCalledWith({
      project_id: "00000000-1000-4000-8000-000000000000",
      account_id: undefined,
      host_id: undefined,
      name: "lro.op-1",
      ephemeral: true,
    });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "progress",
        phase: "copy",
        message: "copying",
        progress: 25,
      }),
      { ttl: 1000 * 60 * 60 },
    );
  });
});
