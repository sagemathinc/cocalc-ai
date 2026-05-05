/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  createInterBayHostControlClient,
  createInterBayProjectControlClient,
} from "./api";
import { DataEncoding, encode } from "@cocalc/conat/core/codec";

describe("inter-bay typed service transport", () => {
  it("uses fast-rpc for short project-control calls", async () => {
    const fastRpcRequest = jest.fn(async () => ({
      raw: encode({ encoding: DataEncoding.MsgPack, mesg: null }),
    }));
    const request = jest.fn();
    const client = createInterBayProjectControlClient({
      client: { fastRpcRequest, request } as any,
      dest_bay: "bay-1",
      timeout: 10_000,
    });

    await expect(
      client.start({ project_id: "p1", account_id: "a1" } as any),
    ).resolves.toBeNull();
    expect(fastRpcRequest).toHaveBeenCalledWith(
      "bay.bay-1.rpc.project-control.start",
      { raw: expect.any(Uint8Array) },
      { timeout: 10_000 },
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("uses request transport for long-running host-control calls", async () => {
    const fastRpcRequest = jest.fn();
    const request = jest.fn(async () => ({ data: { project_id: "p1" } }));
    const client = createInterBayHostControlClient({
      client: { fastRpcRequest, request } as any,
      dest_bay: "bay-1",
      timeout: 60 * 60 * 1000,
    });

    await expect(
      client.startProject({
        host_id: "h1",
        start: { project_id: "p1" },
      } as any),
    ).resolves.toEqual({ project_id: "p1" });
    expect(fastRpcRequest).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      "bay.bay-1.rpc.host-control.start-project",
      {
        name: "startProject",
        args: [{ host_id: "h1", start: { project_id: "p1" } }],
      },
      { timeout: 60 * 60 * 1000, waitForInterest: true },
    );
  });
});
