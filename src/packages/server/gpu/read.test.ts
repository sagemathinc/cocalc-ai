/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

jest.mock("@cocalc/server/gpu/provider-keys", () => ({
  getRunpodClientForAccount: jest.fn(async () => undefined),
  getRunpodCleanupForAccount: jest.fn(async () => undefined),
  isGpuProviderKeysEntitled: jest.fn(async () => true),
}));
// A single bay: every account is homed here.
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: async () => ({ home_bay_id: "bay-0" }),
}));

import { inspect } from "node:util";
import { RunpodClient } from "@cocalc/cloud/runpod/client";
import {
  availabilityOffers,
  clearGpuCatalogCache,
  getGpuAvailability,
  getGpuCatalog,
  getGpuPods,
} from "./read";
import * as hubGpu from "@cocalc/server/conat/api/gpu";

const ACCOUNT = "00000000-1000-4000-8000-000000000001";
const OTHER = "00000000-1000-4000-8000-000000000002";
const KEY = "rpa_SYNTHETICKEY0123456789abcdefghijklmnopqrstuv";
const BOOTSTRAP = "k3J9xQ2mV7pL0aZ5wR8tY1uN4bC6dE0f";

type Reply = { status?: number; body: unknown };

// A fake RunPod that answers by path, counting requests.
function fakeRunpod(routes: Record<string, Reply | (() => Reply)>) {
  const calls: string[] = [];
  const fetch = (async (url: string) => {
    const u = new URL(url);
    const key =
      u.pathname === "/v2/catalog/gpus"
        ? `${u.pathname}?cloud=${u.searchParams.get("cloud")}`
        : u.pathname;
    calls.push(key);
    const route = routes[key];
    if (!route) return new Response("{}", { status: 404 });
    const r = typeof route === "function" ? route() : route;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;
  const purposes: string[] = [];
  const getClient = async (_account_id: string) => {
    purposes.push("operate");
    return new RunpodClient({ apiKey: KEY, fetch });
  };
  // The cleanup capability can only read pods and billing.
  const getCleanup = async (_account_id: string) => {
    purposes.push("cleanup");
    const c = new RunpodClient({ apiKey: KEY, fetch });
    return Object.freeze({
      getProviderIdentity: () => c.getProviderIdentity(),
      listPods: () => c.listPods(),
      getPod: (podId: string) => c.getPod(podId),
      listPodBilling: (...args: Parameters<RunpodClient["listPodBilling"]>) =>
        c.listPodBilling(...args),
    });
  };
  return {
    calls,
    purposes,
    getClient,
    getCleanup,
    isEntitled: async () => true,
    homeClient: async () => undefined,
  };
}

const h100 = {
  id: "NVIDIA H100 80GB HBM3",
  name: "H100 SXM",
  memory: 80,
  secure: true,
  community: true,
  price: { secure: 3.99, community: 2.69 },
  maxCount: { secure: 8, community: 1 },
};
const a4000 = {
  id: "NVIDIA RTX A4000",
  name: "RTX A4000",
  memory: 16,
  secure: true,
  community: true,
  price: { secure: 0.25, community: 0.17 },
  maxCount: { secure: 4, community: 4 },
};

const CATALOG_ROUTES = {
  "/v2/catalog/gpus?cloud=SECURE": {
    body: {
      gpus: [
        {
          ...h100,
          availability: "MEDIUM",
          dataCenters: [
            { id: "US-CA-2", availability: "MEDIUM" },
            { id: "EU-FR-1", availability: "LOW" },
          ],
        },
        {
          ...a4000,
          availability: "HIGH",
          dataCenters: [{ id: "US-CA-2", availability: "HIGH" }],
        },
      ],
    },
  },
  "/v2/catalog/gpus?cloud=COMMUNITY": {
    body: {
      gpus: [
        { ...h100, availability: "NONE" },
        {
          ...a4000,
          availability: "LOW",
          dataCenters: [
            { id: "EU-FR-1", availability: "LOW" },
            { id: "US-CA-2", availability: "NONE" },
          ],
        },
      ],
    },
  },
  "/v2/catalog/datacenters": {
    body: {
      dataCenters: [
        {
          id: "US-CA-2",
          name: "US California 2",
          region: "NORTH_AMERICA",
          compliance: [],
        },
        {
          id: "EU-FR-1",
          name: "EU France 1",
          region: "EUROPE",
          compliance: ["GDPR"],
        },
      ],
    },
  },
};

const POD = {
  id: "pod_abc123",
  name: "cc-7f3k9q2x",
  status: "RUNNING",
  cost: 0.27,
  gpu: { id: "NVIDIA RTX A5000", count: 1 },
  cloud: "COMMUNITY",
  dataCenterId: "EU-FR-1",
  env: { BOOTSTRAP, OTHER: KEY },
  args: `bash -c 'echo ${BOOTSTRAP}'`,
  registry: "reg-1",
  template: "tmpl-1",
};

beforeEach(() => clearGpuCatalogCache());

describe("gpu.catalog", () => {
  it("returns the normalized catalog, read with the account's own key", async () => {
    const rp = fakeRunpod(CATALOG_ROUTES);
    const result = await getGpuCatalog({ account_id: ACCOUNT }, rp);
    expect(result.provider).toBe("runpod");
    expect(result.catalog.gpuTypes.map((t) => t.id)).toEqual([
      "NVIDIA RTX A4000",
      "NVIDIA H100 80GB HBM3",
    ]);
    expect(result.catalog.dataCenters.map((dc) => dc.id)).toEqual([
      "EU-FR-1",
      "US-CA-2",
    ]);
  });

  it("serves repeated reads from one fetch for 30 s, per account", async () => {
    let t = 1_000_000;
    const rp = fakeRunpod(CATALOG_ROUTES);
    const deps = { ...rp, now: () => t };
    await getGpuCatalog({ account_id: ACCOUNT }, deps);
    await getGpuAvailability({ account_id: ACCOUNT }, deps);
    expect(rp.calls).toHaveLength(3);
    await getGpuCatalog({ account_id: OTHER }, deps);
    expect(rp.calls).toHaveLength(6);
    t += 30_001;
    await getGpuCatalog({ account_id: ACCOUNT }, deps);
    expect(rp.calls).toHaveLength(9);
  });

  it("does not cache a failure", async () => {
    let fail = true;
    const rp = fakeRunpod({
      ...CATALOG_ROUTES,
      "/v2/catalog/datacenters": () =>
        fail
          ? { status: 503, body: { detail: "down" } }
          : CATALOG_ROUTES["/v2/catalog/datacenters"],
    });
    await expect(getGpuCatalog({ account_id: ACCOUNT }, rp)).rejects.toThrow(
      "RunPod returned an unexpected response",
    );
    fail = false;
    await expect(
      getGpuCatalog({ account_id: ACCOUNT }, rp),
    ).resolves.toBeDefined();
  });

  it("says how to connect a key when none is connected", async () => {
    await expect(
      getGpuCatalog(
        { account_id: ACCOUNT },
        {
          getClient: async () => undefined,
          isEntitled: async () => true,
          homeClient: async () => undefined,
        },
      ),
    ).rejects.toThrow(
      "No RunPod API key is connected. Connect one in Settings → Connectors.",
    );
  });

  it("needs the live entitlement to read the catalog, but not to list pods", async () => {
    const rp = fakeRunpod({
      ...CATALOG_ROUTES,
      "/v2/pods": {
        body: {
          pods: [],
          pagination: { hasNextPage: false, nextCursor: null },
        },
      },
    });
    const lapsed = { ...rp, isEntitled: async () => false };
    await expect(
      getGpuCatalog({ account_id: ACCOUNT }, lapsed),
    ).rejects.toThrow("Your membership doesn't include GPUs on your own key.");
    await expect(
      getGpuAvailability({ account_id: ACCOUNT }, lapsed),
    ).rejects.toThrow("Your membership doesn't include");
    expect(rp.calls).toHaveLength(0);
    // A lapsed owner can still see what is running (and billing).
    await expect(
      getGpuPods({ account_id: ACCOUNT, scope: "account" }, lapsed),
    ).resolves.toEqual(expect.objectContaining({ pods: [] }));
    expect(rp.purposes).toEqual(["cleanup"]);
    await getGpuCatalog({ account_id: ACCOUNT }, rp);
    expect(rp.purposes).toEqual(["cleanup", "operate"]);
  });

  it("requires an account and a known provider", async () => {
    const rp = fakeRunpod(CATALOG_ROUTES);
    await expect(getGpuCatalog({}, rp)).rejects.toThrow("must be signed in");
    await expect(
      getGpuCatalog({ account_id: ACCOUNT, provider: "lambda" }, rp),
    ).rejects.toThrow("unknown GPU provider");
    expect(rp.calls).toHaveLength(0);
  });
});

describe("gpu.availability", () => {
  const all = async (filter = {}) =>
    (
      await getGpuAvailability(
        { account_id: ACCOUNT, ...filter },
        fakeRunpod(CATALOG_ROUTES),
      )
    ).offers;

  it("lists one row per GPU type, cloud and data center in stock, cheapest first", async () => {
    const offers = await all();
    expect(
      offers.map((o) => [o.gpu_type_id, o.cloud, o.data_center_id, o.stock]),
    ).toEqual([
      ["NVIDIA RTX A4000", "COMMUNITY", "EU-FR-1", "LOW"],
      ["NVIDIA RTX A4000", "SECURE", "US-CA-2", "HIGH"],
      ["NVIDIA H100 80GB HBM3", "SECURE", "US-CA-2", "MEDIUM"],
      ["NVIDIA H100 80GB HBM3", "SECURE", "EU-FR-1", "LOW"],
    ]);
    expect(offers[0]).toEqual({
      gpu_type_id: "NVIDIA RTX A4000",
      gpu_name: "RTX A4000",
      memory_gb: 16,
      cloud: "COMMUNITY",
      data_center_id: "EU-FR-1",
      data_center_name: "EU France 1",
      region: "EUROPE",
      stock: "LOW",
      price_per_gpu_hour: 0.17,
      max_count: 4,
    });
  });

  it("filters by GPU (id or name), cloud, data center, region, stock, price and count", async () => {
    const ids = (offers) =>
      offers.map((o) => `${o.gpu_name}/${o.cloud}/${o.data_center_id}`);
    expect(ids(await all({ gpu: ["h100 sxm"] }))).toEqual([
      "H100 SXM/SECURE/US-CA-2",
      "H100 SXM/SECURE/EU-FR-1",
    ]);
    expect(
      ids(await all({ gpu: ["NVIDIA RTX A4000"], cloud: "SECURE" })),
    ).toEqual(["RTX A4000/SECURE/US-CA-2"]);
    expect(ids(await all({ region: ["europe"] }))).toEqual([
      "RTX A4000/COMMUNITY/EU-FR-1",
      "H100 SXM/SECURE/EU-FR-1",
    ]);
    expect(
      ids(await all({ data_center: ["us-ca-2"], min_stock: "HIGH" })),
    ).toEqual(["RTX A4000/SECURE/US-CA-2"]);
    expect(ids(await all({ max_price_per_gpu_hour: 1 }))).toEqual([
      "RTX A4000/COMMUNITY/EU-FR-1",
      "RTX A4000/SECURE/US-CA-2",
    ]);
    expect(ids(await all({ min_count: 8 }))).toEqual([
      "H100 SXM/SECURE/US-CA-2",
      "H100 SXM/SECURE/EU-FR-1",
    ]);
  });

  it("rejects bad filters before calling RunPod", async () => {
    const rp = fakeRunpod(CATALOG_ROUTES);
    for (const bad of [
      { cloud: "PRIVATE" },
      { min_stock: "LOTS" },
      { max_price_per_gpu_hour: -1 },
      { min_count: 1.5 },
      { gpu: [7] },
    ]) {
      await expect(
        getGpuAvailability({ account_id: ACCOUNT, ...(bad as any) }, rp),
      ).rejects.toThrow();
    }
    expect(rp.calls).toHaveLength(0);
  });

  it("pivots an empty catalog to no offers", () => {
    expect(
      availabilityOffers({ as_of: "x", gpuTypes: [], dataCenters: [] }),
    ).toEqual([]);
  });
});

describe("gpu.pods", () => {
  it("lists the account's pods as allowlisted views, never env or start commands", async () => {
    const rp = fakeRunpod({
      "/v2/pods": {
        body: {
          pods: [POD],
          pagination: { hasNextPage: false, nextCursor: null },
        },
      },
    });
    const result = await getGpuPods(
      { account_id: ACCOUNT, scope: "account" },
      rp,
    );
    expect(result.scope).toBe("account");
    expect(result.pods).toEqual([
      {
        id: "pod_abc123",
        name: "cc-7f3k9q2x",
        status: "RUNNING",
        cost: 0.27,
        gpuTypeId: "NVIDIA RTX A5000",
        gpuCount: 1,
        cloud: "COMMUNITY",
        dataCenterId: "EU-FR-1",
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      new RegExp(`${BOOTSTRAP}|rpa_|reg-1|tmpl-1`),
    );
  });

  it("reads one pod by id, or no pods if it doesn't exist", async () => {
    const rp = fakeRunpod({
      "/v2/pods/pod_abc123": { body: POD },
      "/v2/pods/pod_gone99": { status: 404, body: { detail: "not found" } },
    });
    const one = await getGpuPods(
      { account_id: ACCOUNT, scope: "account", pod_id: "pod_abc123" },
      rp,
    );
    expect(one.pods.map((p) => p.id)).toEqual(["pod_abc123"]);
    const none = await getGpuPods(
      { account_id: ACCOUNT, scope: "account", pod_id: "pod_gone99" },
      rp,
    );
    expect(none.pods).toEqual([]);
    await expect(
      getGpuPods(
        { account_id: ACCOUNT, scope: "account", pod_id: "../v2/billing" },
        rp,
      ),
    ).rejects.toThrow("invalid pod id");
    expect(rp.calls).toEqual(["/v2/pods/pod_abc123", "/v2/pods/pod_gone99"]);
  });

  it("never passes on the key or provider error text", async () => {
    for (const [status, message] of [
      [401, "RunPod rejected your API key; it may have been revoked."],
      [403, "Your RunPod API key lacks permission for this."],
      [429, "RunPod is rate-limiting requests."],
      [500, "RunPod returned an unexpected response."],
    ] as const) {
      const rp = fakeRunpod({
        "/v2/pods": {
          status,
          body: { detail: `bad env ${BOOTSTRAP}`, auth: `Bearer ${KEY}` },
        },
      });
      const err = await getGpuPods(
        { account_id: ACCOUNT, scope: "account" },
        rp,
      ).then(
        () => undefined,
        (e) => e,
      );
      expect(err.message).toContain(message);
      const everything = `${err.message} ${JSON.stringify(err)} ${inspect(err)}`;
      expect(everything).not.toContain(BOOTSTRAP);
      expect(everything).not.toContain(KEY);
    }
  });

  it("reads a pod by its CoCalc handle in the account-wide view", async () => {
    const rp = fakeRunpod({ "/v2/pods/pod_abc123": { body: POD } });
    const record = {
      handle: "cc-7f3k9q2xa4mbn6wd",
      provider_pod_id: "pod_abc123",
    } as any;
    const deps = { ...rp, listManaged: async () => [record] };
    const one = await getGpuPods(
      { account_id: ACCOUNT, scope: "account", pod_id: record.handle },
      deps,
    );
    expect(one.pods.map((p) => p.id)).toEqual(["pod_abc123"]);
    const none = await getGpuPods(
      { account_id: ACCOUNT, scope: "account", pod_id: "cc-aaaaaaaaaaaaaaaa" },
      deps,
    );
    expect(none.pods).toEqual([]);
    // the handle itself never reaches RunPod
    expect(rp.calls).toEqual(["/v2/pods/pod_abc123"]);
  });

  it("still returns the managed records when the key can't be used", async () => {
    const record = {
      id: "00000000-1000-4000-8000-000000000099",
      handle: "cc-7f3k9q2xa4mbn6wd",
      provider: "runpod",
      provider_pod_id: "pod_abc123",
      state: "running",
      desired_state: "running",
    } as any;
    const result = await getGpuPods(
      { account_id: ACCOUNT },
      {
        listManaged: async () => [record],
        getCleanup: async () => undefined,
        homeClient: async () => undefined,
      },
    );
    expect(result.scope).toBe("managed");
    expect(result.records).toEqual([record]);
    expect(result.pods).toEqual([]);
    expect(result.live_error).toMatch(/No RunPod API key is connected/);
  });

  it("still returns the managed records when RunPod rejects the key, with no provider text", async () => {
    const record = {
      id: "00000000-1000-4000-8000-000000000099",
      handle: "cc-7f3k9q2xa4mbn6wd",
      provider: "runpod",
      provider_pod_id: "pod_abc123",
      state: "running",
      desired_state: "running",
    } as any;
    const rp = fakeRunpod({
      "/v2/pods": {
        status: 401,
        body: { detail: `invalid key ${KEY} (secret provider text)` },
      },
    });
    const result = await getGpuPods(
      { account_id: ACCOUNT },
      { ...rp, listManaged: async () => [record] },
    );
    expect(result.records).toEqual([record]);
    expect(result.pods).toEqual([]);
    expect(result.live_error).toMatch(/RunPod rejected your API key/);
    const text = JSON.stringify(result);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("secret provider text");
    // the account-wide listing still fails hard
    await expect(
      getGpuPods({ account_id: ACCOUNT, scope: "account" }, rp),
    ).rejects.toThrow("RunPod rejected your API key");
  });

  it("hides why the key could not be loaded", async () => {
    await expect(
      getGpuPods(
        { account_id: ACCOUNT, scope: "account" },
        {
          getCleanup: async () => {
            throw Error(`decrypt failed for ${KEY}`);
          },
          homeClient: async () => undefined,
        },
      ),
    ).rejects.toThrow(
      /^Your RunPod API key could not be loaded\. Try again shortly\.$/,
    );
  });
});

describe("hub API gpu.*", () => {
  it("ignores any second argument from a caller", async () => {
    // The default client lookup is mocked to find no key: a caller-supplied
    // getClient must not be used.
    const getClient = jest.fn();
    await expect(
      (hubGpu.pods as any)(
        { account_id: ACCOUNT, scope: "account" },
        { getClient },
      ),
    ).rejects.toThrow("No RunPod API key is connected");
    expect(getClient).not.toHaveBeenCalled();
  });
});
