/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// GPU reads for an account homed on another bay run whole on that bay: the
// edge bay never reads the key, and only the request parameters and the
// allowlisted result cross between bays.

import { DataEncoding, decode, encode } from "@cocalc/conat/core/codec";

const edgeGetClient = jest.fn(async () => {
  throw Error("the edge bay must never read the key");
});
const edgeGetCleanup = jest.fn(async () => {
  throw Error("the edge bay must never read the key");
});
jest.mock("@cocalc/server/gpu/provider-keys", () => ({
  getRunpodClientForAccount: (...args) => edgeGetClient(...args),
  getRunpodCleanupForAccount: (...args) => edgeGetCleanup(...args),
  isGpuProviderKeysEntitled: async () => true,
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
const resolveAccountHomeBay = jest.fn(async () => ({ home_bay_id: "bay-1" }));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: (...args) => resolveAccountHomeBay(...args),
}));

// The wire between the bays: every request and reply, as encoded bytes.
const wire: { subject: string; bytes: Uint8Array }[] = [];
let homeImpl: Record<string, (opts: any) => Promise<any>> = {};
const encoded = (mesg: unknown) =>
  encode({ encoding: DataEncoding.MsgPack, mesg });
// GPU reads use request/reply: their timeout is longer than fast RPC allows.
const request = jest.fn(async (subject: string, mesg: any, _opts: any) => {
  wire.push({ subject, bytes: encoded(mesg) });
  const { name, args } = decode({
    encoding: DataEncoding.MsgPack,
    data: encoded(mesg),
  });
  const result = await homeImpl[name](args[0]);
  wire.push({ subject, bytes: encoded(result) });
  return { data: result };
});
const fastRpcRequest = jest.fn(async () => {
  throw Error("GPU reads must not use fast RPC (its timeout is capped)");
});
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({ request, fastRpcRequest }),
}));

import { RunpodClient } from "@cocalc/cloud/runpod/client";
import * as hubGpu from "@cocalc/server/conat/api/gpu";
import {
  GPU_HOME_BAY_TIMEOUT_MS,
  clearGpuCatalogCache,
  getGpuAvailabilityLocal,
  getGpuCatalogLocal,
  getGpuPodsLocal,
} from "./read";

const ACCOUNT = "00000000-1000-4000-8000-000000000001";
const KEY = "rpa_SYNTHETICKEY0123456789abcdefghijklmnopqrstuv";
const BOOTSTRAP = "k3J9xQ2mV7pL0aZ5wR8tY1uN4bC6dE0f";

// The home bay (bay-1) holds the key and talks to RunPod.
function homeBay() {
  const fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    const pod = {
      id: "pod_abc123",
      name: "cc-7f3k9q2x",
      status: "RUNNING",
      env: { BOOTSTRAP, OTHER: KEY },
      args: `echo ${BOOTSTRAP}`,
    };
    const body =
      path === "/v2/pods"
        ? {
            pods: [pod],
            pagination: { hasNextPage: false, nextCursor: null },
          }
        : path === "/v2/pods/pod_abc123"
          ? pod
          : path === "/v2/catalog/gpus"
            ? { gpus: [] }
            : path === "/v2/catalog/datacenters"
              ? { dataCenters: [] }
              : {};
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const client = () => new RunpodClient({ apiKey: KEY, fetch });
  const deps = {
    getClient: async () => client(),
    getCleanup: async () => {
      const c = client();
      return Object.freeze({
        getProviderIdentity: () => c.getProviderIdentity(),
        listPods: () => c.listPods(),
        getPod: (podId: string) => c.getPod(podId),
        listPodBilling: (...args: any[]) => c.listPodBilling(...args),
      });
    },
    isEntitled: async () => true,
  };
  const received: any[] = [];
  homeImpl = {
    gpuCatalog: async (opts) => {
      received.push(opts);
      return await getGpuCatalogLocal(opts, deps);
    },
    gpuAvailability: async (opts) => {
      received.push(opts);
      return await getGpuAvailabilityLocal(opts, deps);
    },
    gpuPods: async (opts) => {
      received.push(opts);
      return await getGpuPodsLocal(opts, deps);
    },
  };
  return { received };
}

function wireText(): string {
  return wire.map((w) => Buffer.from(w.bytes).toString("latin1")).join("\n");
}

beforeEach(() => {
  jest.clearAllMocks();
  clearGpuCatalogCache();
  wire.length = 0;
});

describe("gpu.* for an account homed on another bay", () => {
  it("forwards pods to the home bay; no key or pod secret crosses", async () => {
    const home = homeBay();
    const result = await hubGpu.pods({ account_id: ACCOUNT });
    expect(result.pods).toEqual([
      { id: "pod_abc123", name: "cc-7f3k9q2x", status: "RUNNING" },
    ]);
    expect(resolveAccountHomeBay).toHaveBeenCalledWith({
      account_id: ACCOUNT,
      user_account_id: ACCOUNT,
    });
    expect(wire.map((w) => w.subject)).toEqual([
      "bay.bay-1.rpc.account-local.gpu",
      "bay.bay-1.rpc.account-local.gpu",
    ]);
    // A forwarded read may take as long as a local one: never the inter-bay
    // default, which is shorter than one RunPod request.
    expect(request).toHaveBeenCalledWith(
      "bay.bay-1.rpc.account-local.gpu",
      expect.anything(),
      expect.objectContaining({ timeout: GPU_HOME_BAY_TIMEOUT_MS }),
    );
    expect(fastRpcRequest).not.toHaveBeenCalled();
    expect(GPU_HOME_BAY_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
    expect(home.received).toEqual([{ account_id: ACCOUNT }]);
    expect(edgeGetClient).not.toHaveBeenCalled();
    expect(edgeGetCleanup).not.toHaveBeenCalled();
    const text = wireText();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("rpa_");
    expect(text).not.toContain(BOOTSTRAP);
  });

  it("forwards only the authenticated caller and the read's own parameters", async () => {
    const home = homeBay();
    await hubGpu.availability({
      account_id: ACCOUNT,
      project_id: "00000000-1000-4000-8000-0000000000aa",
      cloud: "SECURE",
      gpu: ["RTX A4000"],
      // anything else a caller adds stays behind
      getClient: "x",
      api_key: KEY,
    } as any);
    await hubGpu.catalog({ account_id: ACCOUNT, provider: "runpod" });
    await hubGpu.pods({ account_id: ACCOUNT, pod_id: "pod_abc123" });
    expect(home.received).toEqual([
      { account_id: ACCOUNT, cloud: "SECURE", gpu: ["RTX A4000"] },
      { account_id: ACCOUNT, provider: "runpod" },
      { account_id: ACCOUNT, pod_id: "pod_abc123" },
    ]);
    expect(wireText()).not.toContain(KEY);
    expect(edgeGetClient).not.toHaveBeenCalled();
    expect(edgeGetCleanup).not.toHaveBeenCalled();
  });

  it("runs locally, without crossing, for an account homed here", async () => {
    resolveAccountHomeBay.mockResolvedValueOnce({ home_bay_id: "bay-0" });
    // The edge mock refuses: this bay was asked for the key itself.
    await expect(hubGpu.pods({ account_id: ACCOUNT })).rejects.toThrow(
      "Your RunPod API key could not be loaded.",
    );
    expect(edgeGetCleanup).toHaveBeenCalledWith(ACCOUNT);
    expect(wire).toHaveLength(0);
  });
});
