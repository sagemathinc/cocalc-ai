/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { MAX_INTEREST_TIMEOUT } from "@cocalc/conat/core/client";
import { DataEncoding, encode } from "@cocalc/conat/core/codec";
import { createInterBayHubApiClient } from "./hub-api";

const CALL = { name: "hosts.getHostLog", args: [{}], source_bay_id: "bay-0" };

function transportClient() {
  const fastRpcRequest = jest.fn(async () => ({
    raw: encode({ encoding: DataEncoding.MsgPack, mesg: { ok: true } }),
  }));
  const request = jest.fn(async () => ({ data: { ok: true } }));
  return { fastRpcRequest, request, client: { fastRpcRequest, request } };
}

describe("forwarded hub API call transport", () => {
  it("uses fast RPC up to its ack limit", async () => {
    const { fastRpcRequest, request, client } = transportClient();
    await createInterBayHubApiClient({
      client: client as any,
      bay_id: "bay-1",
      timeout: MAX_INTEREST_TIMEOUT,
    }).call(CALL);
    expect(fastRpcRequest).toHaveBeenCalledWith(
      "bay.bay-1.rpc.hub-api.v1",
      { raw: expect.any(Uint8Array) },
      { timeout: MAX_INTEREST_TIMEOUT },
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("uses request/reply for a call given longer", async () => {
    const { fastRpcRequest, request, client } = transportClient();
    await createInterBayHubApiClient({
      client: client as any,
      bay_id: "bay-1",
      timeout: MAX_INTEREST_TIMEOUT + 1,
    }).call(CALL);
    expect(fastRpcRequest).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      "bay.bay-1.rpc.hub-api.v1",
      { name: "call", args: [CALL] },
      { timeout: MAX_INTEREST_TIMEOUT + 1, waitForInterest: true },
    );
  });
});
