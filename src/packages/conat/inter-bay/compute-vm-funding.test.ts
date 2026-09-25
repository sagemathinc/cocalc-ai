import { createInterBayAccountLocalClient } from "./api";
import { DataEncoding, encode, decode } from "@cocalc/conat/core/codec";

it.each([
  "reserveComputeVmFunding",
  "lookupComputeVmFunding",
  "getComputeVmFallbackDecision",
  "checkComputeVmFunding",
  "settleComputeVmFunding",
] as const)(
  "routes internal %s to the payer home bay, not the student account",
  async (method) => {
    const fastRpcRequest = jest.fn(async () => ({
      raw: encode({ encoding: DataEncoding.MsgPack, mesg: { ok: true } }),
    }));
    const api = createInterBayAccountLocalClient({
      client: { fastRpcRequest } as any,
      dest_bay: "payer-home",
      timeout: 5000,
    });
    const request = {
      account_id: "payer",
      owner_account_id: "student",
      owning_bay_id: "vm-bay",
    };
    await expect(api[method](request as any)).resolves.toEqual({ ok: true });
    expect(fastRpcRequest).toHaveBeenCalledWith(
      "bay.payer-home.rpc.account-local.compute-funding",
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
