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
    return new Response(next.status === 204 ? null : text, {
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
      { body: { data: { myself: { clientBalance: 1 } } } },
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
    const page = (body: unknown) => client(fakeFetch([{ body }]).fetch);
    for (const body of [
      { items: [] },
      // missing pagination
      { pods: [] },
      // one unparseable row next to a valid one
      {
        pods: [{ id: "pod_aaaaaa" }, { name: "no id" }],
        pagination: { hasNextPage: false },
      },
      // more pages promised but no cursor
      { pods: [], pagination: { hasNextPage: true, nextCursor: null } },
    ]) {
      expect((await failure(page(body).listPods())).kind).toBe("protocol");
    }
  });

  it("fails closed on a malformed single pod", async () => {
    for (const body of [{ name: "no id" }, { id: "pod_other1" }]) {
      const { fetch } = fakeFetch([{ body }]);
      expect((await failure(client(fetch).getPod("pod_abc123"))).kind).toBe(
        "protocol",
      );
    }
  });

  it("fails closed on malformed catalog envelopes", async () => {
    const gpus = client(fakeFetch([{ body: { gpu: [] } }]).fetch);
    expect((await failure(gpus.listGpuTypes("SECURE"))).kind).toBe("protocol");
    const dcs = client(fakeFetch([{ body: {} }]).fetch);
    expect((await failure(dcs.listDataCenters())).kind).toBe("protocol");
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
          metadata: { recordCount: 1, uniquePodCount: 1 },
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

  it("fails closed on malformed or partial billing responses", async () => {
    const good = {
      podId: "pod_abc123",
      startTime: "2026-10-27T04:00:00Z",
      endTime: "2026-10-27T05:00:00Z",
      totalAmount: 0.03,
    };
    for (const body of [
      // missing metadata
      { records: [good] },
      // count mismatch: a partial page
      { records: [good], metadata: { recordCount: 2 } },
      // one valid and one malformed row
      {
        records: [good, { podId: "pod_abc123", startTime: "x" }],
        metadata: { recordCount: 2 },
      },
      // missing total
      {
        records: [{ ...good, totalAmount: undefined }],
        metadata: { recordCount: 1 },
      },
      // negative amount
      { records: [{ ...good, gpuAmount: -1 }], metadata: { recordCount: 1 } },
    ]) {
      const { fetch } = fakeFetch([{ body }]);
      expect((await failure(client(fetch).listPodBilling())).kind).toBe(
        "protocol",
      );
    }
    // a record for another pod when one was asked for
    const { fetch } = fakeFetch([
      {
        body: {
          records: [{ ...good, podId: "pod_other1" }],
          metadata: { recordCount: 1 },
        },
      },
    ]);
    const err = await failure(
      client(fetch).listPodBilling({ podId: "pod_abc123" }),
    );
    expect(err.kind).toBe("protocol");
  });

  it("asks the v2 catalog for pod availability per cloud tier", async () => {
    const { fetch, calls } = fakeFetch([
      { body: { gpus: [] } },
      { body: { gpus: [] } },
    ]);
    await client(fetch).listGpuTypes("SECURE");
    await client(fetch).listGpuTypes("COMMUNITY");
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.runpod.io/v2/catalog/gpus?include=AVAILABILITY&product=POD&cloud=SECURE",
      "https://api.runpod.io/v2/catalog/gpus?include=AVAILABILITY&product=POD&cloud=COMMUNITY",
    ]);
  });

  describe("getProviderIdentity", () => {
    it("uses the organization the key acts for", async () => {
      const { fetch, calls } = fakeFetch([
        { body: { id: "org_123", name: "Physics 101" } },
      ]);
      expect(await client(fetch).getProviderIdentity()).toEqual({
        kind: "organization",
        id: "org_123",
        name: "Physics 101",
      });
      expect(calls[0].url).toBe("https://api.runpod.io/v2/organization");
    });

    it("falls back to the personal account only when organizations are off", async () => {
      const { fetch, calls } = fakeFetch([
        {
          status: 403,
          body: {
            title: "Forbidden",
            status: 403,
            detail: "Organizations are not enabled for this user",
          },
        },
        { body: { data: { myself: { id: "user_1" } } } },
      ]);
      expect(await client(fetch).getProviderIdentity()).toEqual({
        kind: "personal",
        id: "user_1",
      });
      expect(calls[1].url).toBe("https://api.runpod.io/graphql");
    });

    it("does not treat any other 403 as a personal account", async () => {
      const { fetch } = fakeFetch([
        { status: 403, body: { title: "Forbidden", detail: "nope" } },
      ]);
      const err = await failure(client(fetch).getProviderIdentity());
      expect(err.kind).toBe("forbidden");
      expect(err.reason).toBeUndefined();
    });

    it("fails closed on an organization without an id", async () => {
      const { fetch } = fakeFetch([{ body: { name: "x" } }]);
      expect((await failure(client(fetch).getProviderIdentity())).kind).toBe(
        "protocol",
      );
    });
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

  it("probes pod access with exactly one request", async () => {
    const { fetch, calls } = fakeFetch([
      {
        body: { pods: [], pagination: { hasNextPage: true, nextCursor: "x" } },
      },
    ]);
    await client(fetch).canListPods();
    expect(calls.map((c) => c.url)).toEqual(["https://api.runpod.io/v2/pods"]);
    const bad = fakeFetch([{ body: { pods: "nope" } }]);
    expect((await failure(client(bad.fetch).canListPods())).kind).toBe(
      "protocol",
    );
  });

  it("probes write access by creating and deleting a private template", async () => {
    const ok = fakeFetch([
      { status: 201, body: { id: "tpl_1", name: "x" } },
      { status: 204, body: "" },
    ]);
    await client(ok.fetch).canWritePods();
    expect(ok.calls.map((c) => [c.init.method, c.url])).toEqual([
      ["POST", "https://api.runpod.io/v2/templates"],
      ["DELETE", "https://api.runpod.io/v2/templates/tpl_1"],
    ]);
    const sent = JSON.parse(`${ok.calls[0].init.body}`);
    expect(sent.name).toMatch(/^cc-permission-probe-[0-9a-f]{12}$/);
    expect(sent.image).toBe("busybox:latest");
    // Read Only keys are refused at the create (measured 10-27).
    const readOnly = fakeFetch([
      { status: 403, body: { detail: "Forbidden" } },
    ]);
    expect((await failure(client(readOnly.fetch).canWritePods())).kind).toBe(
      "forbidden",
    );
    // A create without an id fails closed, and the probe is looked up by
    // name and deleted in case RunPod did create it.
    const odd = fakeFetch([
      { status: 201, body: {} },
      { body: [{ id: "tpl_x", name: "someone-else" }] },
    ]);
    expect((await failure(client(odd.fetch).canWritePods())).kind).toBe(
      "protocol",
    );
    expect(odd.calls.map((c) => c.init.method)).toEqual(["POST", "GET"]);
    // A lost reply: RunPod created the template, but we never saw its id.
    // It is found by its random name and deleted.
    const seen: Array<[string | undefined, string]> = [];
    let probe = "";
    const lostReply = (async (url: string, init: RequestInit) => {
      seen.push([init.method, url]);
      if (init.method === "POST") {
        probe = JSON.parse(`${init.body}`).name;
        return new Response("", { status: 502 });
      }
      if (init.method === "GET") {
        return new Response(JSON.stringify([{ id: "tpl_lost", name: probe }]));
      }
      return new Response(null, { status: 204 });
    }) as unknown as typeof globalThis.fetch;
    await failure(client(lostReply).canWritePods());
    expect(seen).toEqual([
      ["POST", "https://api.runpod.io/v2/templates"],
      ["GET", "https://api.runpod.io/v2/templates"],
      ["DELETE", "https://api.runpod.io/v2/templates/tpl_lost"],
    ]);
    // A failed delete is retried once, and the key still counts as writable.
    const retry = fakeFetch([
      { status: 201, body: { id: "tpl_2" } },
      { status: 500, body: "" },
      { status: 204, body: "" },
    ]);
    await client(retry.fetch).canWritePods();
    expect(retry.calls).toHaveLength(3);
  });
});
