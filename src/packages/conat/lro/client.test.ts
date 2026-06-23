import { EventEmitter } from "events";

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

  it("can finish from a durable summary fallback when the stream has no terminal event", async () => {
    const { waitForCompletion } = await import("./client");
    const stream = Object.assign(new EventEmitter(), {
      getAll: jest.fn(() => []),
      close: jest.fn(),
    });
    const client = {
      sync: {
        dstream: jest.fn(async () => stream),
      },
    } as any;
    const summary = {
      op_id: "op-1",
      kind: "project-backup",
      scope_type: "project",
      scope_id: "00000000-1000-4000-8000-000000000000",
      status: "succeeded",
    } as any;

    await expect(
      waitForCompletion({
        op_id: "op-1",
        scope_type: "project",
        scope_id: "00000000-1000-4000-8000-000000000000",
        client,
        poll_ms: 250,
        getSummary: jest.fn(async () => summary),
      }),
    ).resolves.toBe(summary);

    expect(stream.close).toHaveBeenCalled();
  });

  it("can finish from a durable summary fallback when stream open fails", async () => {
    const { waitForCompletion } = await import("./client");
    const client = {
      sync: {
        dstream: jest.fn(async () => {
          throw new Error("stream unavailable");
        }),
      },
    } as any;
    const summary = {
      op_id: "op-1",
      kind: "project-backup",
      scope_type: "project",
      scope_id: "00000000-1000-4000-8000-000000000000",
      status: "succeeded",
    } as any;

    await expect(
      waitForCompletion({
        op_id: "op-1",
        scope_type: "project",
        scope_id: "00000000-1000-4000-8000-000000000000",
        client,
        getSummary: jest.fn(async () => summary),
      }),
    ).resolves.toBe(summary);
  });

  it("can finish from a durable summary fallback when stream open hangs", async () => {
    const { waitForCompletion } = await import("./client");
    const client = {
      sync: {
        dstream: jest.fn(() => new Promise(() => {})),
      },
    } as any;
    const summary = {
      op_id: "op-1",
      kind: "project-backup",
      scope_type: "project",
      scope_id: "00000000-1000-4000-8000-000000000000",
      status: "succeeded",
    } as any;

    await expect(
      waitForCompletion({
        op_id: "op-1",
        scope_type: "project",
        scope_id: "00000000-1000-4000-8000-000000000000",
        client,
        getSummary: jest.fn(async () => summary),
      }),
    ).resolves.toBe(summary);
  });
});
