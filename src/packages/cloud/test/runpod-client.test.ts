import { inspect } from "node:util";
import { RunpodApiError, RunpodClient } from "../runpod/client";
import { podView } from "../runpod/views";

const KEY = "rpa_SYNTHETICKEY0123456789abcdefghijklmnopqrstuv";
// A per-request secret with no recognizable prefix, like the one-time SSH
// bootstrap token the write path will put in a pod's env.
const BOOTSTRAP = "k3J9xQ2mV7pL0aZ5wR8tY1uN4bC6dE0f";

type Call = { url: string; init: RequestInit };

function fakeFetch(
  responses: Array<{
    status?: number;
    body: unknown;
    headers?: Record<string, string>;
  }>,
) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    const text =
      typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(text, {
      status: next.status ?? 200,
      headers: next.headers,
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function client(fetch: typeof globalThis.fetch) {
  return new RunpodClient({ apiKey: KEY, fetch });
}

async function failure(p: Promise<unknown>): Promise<RunpodApiError> {
  const err = await p.then(
    () => undefined,
    (e) => e,
  );
  expect(err).toBeInstanceOf(RunpodApiError);
  return err;
}

describe("RunpodClient", () => {
  it("calls REST v2 with a bearer key, our user agent, and no redirects", async () => {
    const { fetch, calls } = fakeFetch([
      {
        body: {
          pods: [],
          pagination: { hasNextPage: false, nextCursor: null },
        },
      },
    ]);
    await client(fetch).listPods();
    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe("https://api.runpod.io/v2/pods");
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    // Cloudflare blocks some default user agents (error 1010).
    expect(headers["User-Agent"]).toMatch(/^cocalc-runpod\//);
    expect(calls[0].init.redirect).toBe("error");
  });

  it("has no option to send the key to another origin", async () => {
    const { fetch, calls } = fakeFetch([
      { body: { dataCenters: [] } },
      { body: { data: { myself: { id: "user_1" } } } },
    ]);
    const c = new RunpodClient({
      apiKey: KEY,
      fetch,
      restUrl: "https://evil.example",
      graphqlUrl: "https://evil.example/graphql",
      baseUrl: "https://evil.example",
    } as any);
    await c.listDataCenters();
    await c.getAccountBalance();
    expect(calls.map((x) => new URL(x.url).origin)).toEqual([
      "https://api.runpod.io",
      "https://api.runpod.io",
    ]);
  });

  it("never reveals the key through inspect or JSON", () => {
    const c = client(fakeFetch([]).fetch);
    expect(inspect(c)).not.toContain(KEY);
    expect(JSON.stringify(c)).not.toContain(KEY);
    expect(JSON.stringify({ c })).not.toContain("rpa_");
  });

  it("rejects a missing or malformed key", () => {
    expect(() => new RunpodClient({ apiKey: "" })).toThrow(/required/);
    expect(() => new RunpodClient({ apiKey: "a b" })).toThrow(/required/);
  });

  it("follows pagination cursors for the pod inventory", async () => {
    const { fetch, calls } = fakeFetch([
      {
        body: {
          pods: [{ id: "pod_aaaaaa" }],
          pagination: { hasNextPage: true, nextCursor: "c/2?x=1" },
        },
      },
      {
        body: {
          pods: [{ id: "pod_bbbbbb" }],
          pagination: { hasNextPage: false, nextCursor: null },
        },
      },
    ]);
    const pods = await client(fetch).listPods();
    expect(pods.map((p) => p.id)).toEqual(["pod_aaaaaa", "pod_bbbbbb"]);
    expect(calls[1].url).toBe(
      "https://api.runpod.io/v2/pods?cursor=c%2F2%3Fx%3D1",
    );
  });

  it("treats a malformed inventory as an error, not an empty list", async () => {
    const { fetch } = fakeFetch([{ body: { items: [] } }]);
    expect((await failure(client(fetch).listPods())).kind).toBe("protocol");
  });

  it("keeps only allowlisted pod fields", async () => {
    const { fetch } = fakeFetch([
      {
        body: {
          pods: [
            {
              id: "pod_abc123",
              name: "cc-7f3k9q2x",
              status: "RUNNING",
              cost: 0.27,
              gpu: { id: "NVIDIA RTX A5000", count: 1, vcpuCount: 9 },
              cloud: "SECURE",
              dataCenterId: "EU-RO-1",
              image: "runpod/pytorch@sha256:abc",
              env: { BOOTSTRAP, OTHER: KEY },
              args: `bash -c 'echo ${BOOTSTRAP}'`,
              cmd: [BOOTSTRAP],
              entrypoint: ["/bin/bash"],
              registry: "reg-1",
              template: "tmpl-1",
              mounts: { volume: { id: "vol-1" } },
              ssh: {
                direct: {
                  host: "203.0.113.7",
                  port: 40022,
                  username: "root",
                  command: `ssh root@203.0.113.7 # ${BOOTSTRAP}`,
                },
                proxy: null,
              },
              somethingNew: "x",
            },
          ],
          pagination: { hasNextPage: false, nextCursor: null },
        },
      },
    ]);
    const [pod] = await client(fetch).listPods();
    expect(pod).toEqual({
      id: "pod_abc123",
      name: "cc-7f3k9q2x",
      status: "RUNNING",
      cost: 0.27,
      gpuTypeId: "NVIDIA RTX A5000",
      gpuCount: 1,
      cloud: "SECURE",
      dataCenterId: "EU-RO-1",
      image: "runpod/pytorch@sha256:abc",
      sshDirect: { host: "203.0.113.7", port: 40022, username: "root" },
    });
    expect(JSON.stringify(pod)).not.toMatch(
      new RegExp(`${BOOTSTRAP}|rpa_|reg-1|tmpl-1|vol-1`),
    );
  });

  it("never returns provider error bodies, even with an unprefixed secret echoed", async () => {
    const echoed = {
      title: "Bad Request",
      status: 400,
      detail: `invalid env value ${BOOTSTRAP}`,
      errors: [`env.BOOTSTRAP=${BOOTSTRAP}`, `Bearer ${KEY}`],
    };
    const { fetch } = fakeFetch([{ status: 400, body: echoed }]);
    const err = await failure(client(fetch).listPods());
    expect(err.kind).toBe("invalid");
    expect(err.status).toBe(400);
    const everything = `${err.message} ${JSON.stringify(err)} ${inspect(err)}`;
    expect(everything).not.toContain(BOOTSTRAP);
    expect(everything).not.toContain(KEY);
    expect(err.message).toBe("RunPod rejected the request as invalid (400)");
  });

  it("separates a rejected key (401) from a key that lacks scope (403)", async () => {
    const auth = await failure(
      client(
        fakeFetch([{ status: 401, body: { title: "Unauthorized" } }]).fetch,
      ).listPods(),
    );
    expect(auth.kind).toBe("auth");
    // A narrowed key may be refused billing yet still able to inventory and
    // terminate pods: 403 must not read as "the key is gone".
    const { fetch } = fakeFetch([
      { status: 403, body: { title: "Forbidden" } },
      { body: { pods: [], pagination: { hasNextPage: false } } },
    ]);
    const c = client(fetch);
    expect((await failure(c.listPodBilling())).kind).toBe("forbidden");
    await expect(c.listPods()).resolves.toEqual([]);
  });

  it("reports rate limits with Retry-After", async () => {
    const { fetch } = fakeFetch([
      { status: 429, body: "", headers: { "retry-after": "12" } },
    ]);
    const err = await failure(client(fetch).listDataCenters());
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterSeconds).toBe(12);
  });

  it("keeps nothing from network errors", async () => {
    const fetch = (async () => {
      throw new Error(`connect failed with Authorization: Bearer ${KEY}`);
    }) as unknown as typeof globalThis.fetch;
    const err = await failure(client(fetch).listPods());
    expect(err.kind).toBe("network");
    expect(err.message).toBe("could not reach RunPod");
  });

  it("returns undefined for a pod that no longer exists", async () => {
    const { fetch } = fakeFetch([{ status: 404, body: "" }]);
    expect(await client(fetch).getPod("pod_abc123")).toBeUndefined();
  });

  it("refuses ids and times that could change the request", async () => {
    const c = client(fakeFetch([]).fetch);
    await expect(c.getPod("../billing")).rejects.toThrow(/invalid/);
    await expect(c.listPodBilling({ podId: "a&b=c" })).rejects.toThrow(
      /invalid/,
    );
    await expect(
      c.listPodBilling({
        startTime: "2026-10-27&podId=x",
        endTime: "2026-10-28T00:00:00Z",
      }),
    ).rejects.toThrow(/invalid/);
    await expect(
      c.listPodBilling({ startTime: "2026-10-27T00:00:00Z" }),
    ).rejects.toThrow(/together/);
  });

  it("reads per-pod billing records from v2", async () => {
    const { fetch, calls } = fakeFetch([
      {
        body: {
          records: [
            {
              podId: "pod_abc123",
              startTime: "2026-10-27T04:00:00Z",
              endTime: "2026-10-27T05:00:00Z",
              totalAmount: 0.03,
              gpuAmount: 0.02,
              extra: 1,
            },
          ],
          metadata: { recordCount: 1 },
        },
      },
    ]);
    const rows = await client(fetch).listPodBilling({
      podId: "pod_abc123",
      startTime: "2026-10-27T00:00:00Z",
      endTime: "2026-10-27T06:00:00Z",
    });
    expect(calls[0].url).toBe(
      "https://api.runpod.io/v2/billing/pods?bucketSize=hour&podId=pod_abc123&startTime=2026-10-27T00%3A00%3A00Z&endTime=2026-10-27T06%3A00%3A00Z",
    );
    expect(rows).toEqual([
      {
        podId: "pod_abc123",
        startTime: "2026-10-27T04:00:00Z",
        endTime: "2026-10-27T05:00:00Z",
        totalAmount: 0.03,
        gpuAmount: 0.02,
      },
    ]);
  });

  it("asks the v2 catalog for pod availability", async () => {
    const { fetch, calls } = fakeFetch([{ body: { gpus: [] } }]);
    await client(fetch).listGpuTypes();
    expect(calls[0].url).toBe(
      "https://api.runpod.io/v2/catalog/gpus?include=AVAILABILITY&product=POD",
    );
  });

  describe("getAccountBalance (temporary GraphQL read)", () => {
    it("reads balance and spend", async () => {
      const { fetch, calls } = fakeFetch([
        {
          body: {
            data: {
              myself: {
                id: "user_1",
                clientBalance: 30.17,
                currentSpendPerHr: 0.061,
                spendLimit: 80,
              },
            },
          },
        },
      ]);
      expect(await client(fetch).getAccountBalance()).toEqual({
        accountId: "user_1",
        balance: 30.17,
        spendPerHour: 0.061,
        spendLimitPerHour: 80,
      });
      expect(calls[0].url).toBe("https://api.runpod.io/graphql");
    });

    it("maps a valid key without account scope to forbidden", async () => {
      const { fetch } = fakeFetch([
        {
          body: {
            errors: [
              { message: "Unauthorized", extensions: { code: "UNAUTHORIZED" } },
            ],
          },
        },
      ]);
      expect((await failure(client(fetch).getAccountBalance())).kind).toBe(
        "forbidden",
      );
    });

    it("maps a rejected key to auth", async () => {
      const { fetch } = fakeFetch([{ status: 401, body: { error: {} } }]);
      expect((await failure(client(fetch).getAccountBalance())).kind).toBe(
        "auth",
      );
    });
  });
});

describe("podView", () => {
  it("ignores rows that aren't pods", () => {
    expect(podView(null)).toBeUndefined();
    expect(podView({ name: "no id" })).toBeUndefined();
  });

  it("drops image references that carry credentials", () => {
    expect(podView({ id: "pod_x1y2z3", image: "u:p@reg.io/img" })).toEqual({
      id: "pod_x1y2z3",
    });
    expect(
      podView({ id: "pod_x1y2z3", image: "https://u:p@reg.io/img" }),
    ).toEqual({ id: "pod_x1y2z3" });
    expect(podView({ id: "pod_x1y2z3", image: "ubuntu@sha256:ab" })).toEqual({
      id: "pod_x1y2z3",
      image: "ubuntu@sha256:ab",
    });
  });
});
