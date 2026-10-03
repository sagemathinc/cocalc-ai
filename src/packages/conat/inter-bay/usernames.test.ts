import { createInterBayUsernamesClient } from "./usernames";
import { DataEncoding, decode, encode } from "@cocalc/conat/core/codec";

test.each(["", "bay.*", "bay.>", "bay one"])(
  "invalid username authority subject %s",
  (bay) => {
    expect(() => createInterBayUsernamesClient({} as any, bay)).toThrow(
      "Invalid bay id",
    );
  },
);

test.each([
  "getUsername",
  "setUsername",
  "releaseRedirect",
  "resolveOwner",
] as const)(
  "%s uses the versioned seed RPC and retains actor and explicit owner",
  async (method) => {
    const fastRpcRequest = jest.fn(async () => ({
      raw: encode({ encoding: DataEncoding.MsgPack, mesg: {} }),
    }));
    const api = createInterBayUsernamesClient(
      { fastRpcRequest } as any,
      "seed",
    );
    const opts = {
      account_id: "actor",
      owner_account_id: "owner",
      username: "zephyr",
      owner: "zephyr",
      reason: "cleanup",
      session_hash: "bound",
    };
    await api[method](opts);
    expect(fastRpcRequest).toHaveBeenCalledWith(
      "bay.seed.rpc.usernames.v1",
      { raw: expect.any(Uint8Array) },
      { timeout: 15000 },
    );
    expect(
      decode({
        encoding: DataEncoding.MsgPack,
        data: fastRpcRequest.mock.calls[0][1].raw,
      }),
    ).toEqual({ name: method, args: [opts] });
  },
);
