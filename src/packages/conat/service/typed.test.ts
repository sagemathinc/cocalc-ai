import { createServiceClient, createServiceHandler } from "./typed";
import { DataEncoding, decode, encode } from "../core/codec";

describe("typed service client", () => {
  it("is not treated as a thenable when returned from async code", async () => {
    const client = createServiceClient<any>({
      service: "test",
      subject: "test.subject",
      client: {} as any,
    });

    expect((client as any).then).toBeUndefined();

    const wrapped = async () => client;

    await expect(wrapped()).resolves.toBe(client);
  });

  it("uses fast rpc by default", async () => {
    const fastRpcRequest = jest.fn(async () => ({
      raw: encode({ encoding: DataEncoding.MsgPack, mesg: "ok" }),
    }));
    const client = createServiceClient<any>({
      service: "test",
      subject: "test.subject",
      client: { fastRpcRequest } as any,
    });

    await expect(client.add(2, 3)).resolves.toBe("ok");
    expect(fastRpcRequest).toHaveBeenCalledWith(
      "test.subject",
      { raw: expect.any(Uint8Array) },
      { timeout: undefined },
    );
    expect(
      decode({
        encoding: DataEncoding.MsgPack,
        data: fastRpcRequest.mock.calls[0][1].raw,
      }),
    ).toEqual({ name: "add", args: [2, 3] });
  });

  it("can use the legacy request transport", async () => {
    const request = jest.fn(async () => ({ data: "ok" }));
    const client = createServiceClient<any>({
      service: "test",
      subject: "test.subject",
      transport: "request",
      client: { request } as any,
    });

    await expect(client.add(2, 3)).resolves.toBe("ok");
    expect(request).toHaveBeenCalledWith(
      "test.subject",
      { name: "add", args: [2, 3] },
      { timeout: 10000, waitForInterest: true },
    );
  });

  it("registers typed services with fast rpc by default", async () => {
    let handler: ((mesg: { name: string; args?: any[] }) => any) | undefined;
    const fastRpcService = jest.fn(async (_subject, h) => {
      handler = h;
      return { close: jest.fn(), stop: jest.fn() };
    });
    const subscribe = jest.fn(async () => ({
      stop: jest.fn(),
      [Symbol.asyncIterator]: async function* () {},
    }));

    createServiceHandler<any>({
      service: "test",
      subject: "test.subject",
      client: { fastRpcService, subscribe } as any,
      impl: {
        add: async (a: number, b: number) => a + b,
      },
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(fastRpcService).toHaveBeenCalledWith(
      "test.subject",
      expect.any(Function),
      { queue: "0" },
    );
    const add = await handler!({
      raw: encode({
        encoding: DataEncoding.MsgPack,
        mesg: { name: "add", args: [2, 3] },
      }),
    } as any);
    expect(decode({ encoding: DataEncoding.MsgPack, data: add.raw })).toBe(5);
    const ping = await handler!({
      raw: encode({
        encoding: DataEncoding.MsgPack,
        mesg: { name: "__conat_ping", args: [] },
      }),
    } as any);
    expect(decode({ encoding: DataEncoding.MsgPack, data: ping.raw })).toBe(
      "pong",
    );
  });
});
