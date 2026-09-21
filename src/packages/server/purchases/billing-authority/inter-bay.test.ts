/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const mockCreateClient = jest.fn();
const mockCreateHandler = jest.fn();
const mockFabricClient = jest.fn(() => ({ fabric: true }));
const mockBayId = jest.fn(() => "seed");

jest.mock("@cocalc/conat/service/typed", () => ({
  createServiceClient: (...args: unknown[]) => mockCreateClient(...args),
  createServiceHandler: (...args: unknown[]) => mockCreateHandler(...args),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: (...args: unknown[]) => mockFabricClient(...args),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => mockBayId(),
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterSeedBayId: () => "seed",
}));

import {
  billingAuthoritySubject,
  callSeedBillingAuthority,
  createBillingAuthorityInterBayService,
} from "./inter-bay";

describe("billing authority inter-bay transport", () => {
  beforeEach(() => {
    mockBayId.mockReset().mockReturnValue("seed");
    mockFabricClient.mockClear();
    mockCreateClient.mockReset();
    mockCreateHandler.mockReset();
  });

  it("addresses the seed over a private bay RPC subject", async () => {
    const transport = jest.fn(async () => ({ ok: true, value: 17 }));
    mockCreateClient.mockReturnValue({ transport });
    const request = { action: "health" } as const;
    await expect(callSeedBillingAuthority(request)).resolves.toEqual({
      ok: true,
      value: 17,
    });
    expect(mockCreateClient).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "bay.seed.rpc.billing-authority.transport",
        client: { fabric: true },
      }),
    );
    expect(transport).toHaveBeenCalledWith(request);
    expect(billingAuthoritySubject("bay-2")).toBe(
      "bay.bay-2.rpc.billing-authority.transport",
    );
  });

  it("registers a handler only on the seed", () => {
    const handle = jest.fn();
    mockCreateHandler.mockReturnValue({ close: jest.fn() });
    expect(createBillingAuthorityInterBayService({ handle })).toBeDefined();
    expect(mockFabricClient).toHaveBeenCalledWith({ noCache: true });
    expect(mockCreateHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "bay.seed.rpc.billing-authority.transport",
        parallel: true,
        impl: { transport: handle },
      }),
    );

    mockBayId.mockReturnValue("bay-1");
    mockCreateHandler.mockClear();
    expect(createBillingAuthorityInterBayService({ handle })).toBeUndefined();
    expect(mockCreateHandler).not.toHaveBeenCalled();
  });
});
