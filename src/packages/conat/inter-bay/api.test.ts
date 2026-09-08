/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  createInterBayBayOpsClient,
  createInterBayHostControlClient,
  createInterBayProjectControlClient,
} from "./api";
import { DataEncoding, encode } from "@cocalc/conat/core/codec";

describe("inter-bay typed service transport", () => {
  it.each([
    ["bootstrapCloudflareConfiguration", "bootstrap-cloudflare-configuration"],
    ["reconcileCloudflareBlobs", "reconcile-cloudflare-blobs"],
  ] as const)(
    "routes %s to seed with the provisioning timeout",
    async (method, subject) => {
      const fastRpcRequest = jest.fn(async () => ({
        raw: encode({ encoding: DataEncoding.MsgPack, mesg: { ok: true } }),
      }));
      const request = jest.fn(async () => ({ data: { ok: true } }));
      const client = createInterBayBayOpsClient({
        client: { fastRpcRequest, request } as any,
        dest_bay: "seed",
        timeout: 600_000,
      });
      await expect(
        client[method]({
          account_id: "operator",
          source_bay_id: "attached-a",
          domain: "example.com",
          token: "bootstrap-secret",
        }),
      ).resolves.toEqual({ ok: true });
      expect(request).toHaveBeenCalledWith(
        `bay.seed.rpc.bay-ops.${subject}`,
        expect.anything(),
        { timeout: 600_000, waitForInterest: true },
      );
      expect(fastRpcRequest).not.toHaveBeenCalled();
    },
  );

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

  it("uses fast-rpc for project usage-account control calls", async () => {
    const fastRpcRequest = jest.fn(async () => ({
      raw: encode({ encoding: DataEncoding.MsgPack, mesg: { updated: true } }),
    }));
    const request = jest.fn();
    const client = createInterBayProjectControlClient({
      client: { fastRpcRequest, request } as any,
      dest_bay: "bay-1",
      timeout: 10_000,
    });

    await expect(
      client.setUsageAccount({
        project_id: "p1",
        usage_account_id: "a1",
      } as any),
    ).resolves.toEqual({ updated: true });
    expect(fastRpcRequest).toHaveBeenCalledWith(
      "bay.bay-1.rpc.project-control.set-usage-account",
      { raw: expect.any(Uint8Array) },
      { timeout: 10_000 },
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("routes hard-delete evidence to the exact destination bay", async () => {
    const response = {
      project_id: "p1",
      bay_id: "bay-1",
      status: "hard-deleted" as const,
    };
    const fastRpcRequest = jest.fn(async () => ({
      raw: encode({ encoding: DataEncoding.MsgPack, mesg: response }),
    }));
    const request = jest.fn();
    const client = createInterBayProjectControlClient({
      client: { fastRpcRequest, request } as any,
      dest_bay: "bay-1",
      timeout: 10_000,
    });

    await expect(
      client.hardDeleteStatus({ project_id: "p1" }),
    ).resolves.toEqual(response);
    expect(fastRpcRequest).toHaveBeenCalledWith(
      "bay.bay-1.rpc.project-control.hard-delete-status",
      { raw: expect.any(Uint8Array) },
      { timeout: 10_000 },
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("routes RootFS writes to the exact destination bay", async () => {
    const response = [
      { project_id: "p1", state_role: "current", image: "rootfs/new" },
    ];
    const fastRpcRequest = jest.fn(async () => ({
      raw: encode({ encoding: DataEncoding.MsgPack, mesg: response }),
    }));
    const request = jest.fn();
    const client = createInterBayProjectControlClient({
      client: { fastRpcRequest, request } as any,
      dest_bay: "bay-1",
      timeout: 10_000,
    });

    await expect(
      client.setRootfsImage({
        project_id: "p1",
        account_id: "a1",
        image: "rootfs/new",
        epoch: 2,
      }),
    ).resolves.toEqual(response);
    expect(fastRpcRequest).toHaveBeenCalledWith(
      "bay.bay-1.rpc.project-control.set-rootfs-image",
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
