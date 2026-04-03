describe("lro client explicit routing", () => {
  it("requires an explicit Conat client for get", async () => {
    const { get } = await import("./client");

    await expect(
      get({
        op_id: "op-1",
        scope_type: "hub",
      }),
    ).rejects.toThrow("must provide an explicit Conat client");
  });

  it("requires an explicit Conat client for waitForCompletion", async () => {
    const { waitForCompletion } = await import("./client");

    await expect(
      waitForCompletion({
        op_id: "op-1",
        scope_type: "hub",
      }),
    ).rejects.toThrow("must provide an explicit Conat client");
  });

  it("opens the stream with an explicit client", async () => {
    const { get } = await import("./client");
    const dstream = { close: jest.fn() };
    const client = {
      sync: {
        dstream: jest.fn(async () => dstream),
      },
    } as any;

    await expect(
      get({
        op_id: "op-1",
        scope_type: "project",
        scope_id: "00000000-1000-4000-8000-000000000000",
        client,
      }),
    ).resolves.toBe(dstream as any);

    expect(client.sync.dstream).toHaveBeenCalledWith({
      project_id: "00000000-1000-4000-8000-000000000000",
      name: "lro.op-1",
      ephemeral: true,
      config: {
        max_msgs: 2000,
        max_age: 2 * 60 * 60 * 1000,
        max_bytes: 8 * 1024 * 1024,
        allow_msg_ttl: true,
      },
    });
  });
});
