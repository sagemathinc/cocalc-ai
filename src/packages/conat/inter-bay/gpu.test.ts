import { createInterBayAccountLocalClient } from "./api";
import { DataEncoding, encode, decode } from "@cocalc/conat/core/codec";

it.each(["gpuCatalog", "gpuAvailability", "gpuPods"] as const)(
  "routes %s to the key owner's home bay on the account-local gpu subject",
  async (method) => {
    const fastRpcRequest = jest.fn(async () => ({
      raw: encode({ encoding: DataEncoding.MsgPack, mesg: { ok: true } }),
    }));
    const api = createInterBayAccountLocalClient({
      client: { fastRpcRequest } as any,
      dest_bay: "key-home",
      timeout: 5000,
    });
    const request = { account_id: "owner" };
    await expect(api[method](request as any)).resolves.toEqual({ ok: true });
    expect(fastRpcRequest).toHaveBeenCalledWith(
      "bay.key-home.rpc.account-local.gpu",
      { raw: expect.any(Uint8Array) },
      { timeout: 5000 },
    );
    expect(
      decode({
        encoding: DataEncoding.MsgPack,
        data: (fastRpcRequest.mock.calls[0] as any)[1].raw,
      }),
    ).toEqual(expect.objectContaining({ name: method, args: [request] }));
  },
);
