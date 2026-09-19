import { createInterBayAccountLocalClient } from "./api";
import { DataEncoding, encode, decode } from "@cocalc/conat/core/codec";

const methods = [
  "computeFundingGetOwnedPools",
  "computeFundingGetRolloutCapabilities",
  "computeFundingCheckApprovalRecipients",
  "computeFundingGetCourseVmRecommendations",
  "computeFundingSetCourseVmRecommendations",
  "computeFundingGetPublishedCourseVmRecommendations",
  "computeFundingPreviewPoolChange",
  "computeFundingProposePoolChange",
  "computeFundingGetCourseSummary",
  "computeFundingListSources",
  "computeFundingListSourcesOnBay",
  "computeFundingPreviewAllocation",
  "computeFundingProposeAllocation",
  "computeFundingGetAllocationStatus",
] as const;

it.each(methods)(
  "routes %s through the registered account-local funding subject",
  async (method) => {
    const fastRpcRequest = jest.fn(async () => ({
      raw: encode({ encoding: DataEncoding.MsgPack, mesg: { ok: true } }),
    }));
    const api = createInterBayAccountLocalClient({
      client: { fastRpcRequest } as any,
      dest_bay: "payer-home",
      timeout: 5000,
    });
    const request = { account_id: "payer" };
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
