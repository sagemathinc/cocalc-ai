import { inspect } from "node:util";
import { RunpodApiError, RunpodClient } from "../runpod/client";
import { podView, scrubText } from "../runpod/scrub";

const KEY = "rpa_SYNTHETICKEY0123456789abcdefghijklmnopqrstuv";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    const text =
      typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(text, { status: next.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("RunpodClient", () => {
  it("authenticates with a bearer key and our own user agent", async () => {
    const { fetch, calls } = fakeFetch([{ body: [] }]);
    await new RunpodClient({ apiKey: KEY, fetch }).listPods();
    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe("https://rest.runpod.io/v1/pods");
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    // Cloudflare blocks some default user agents (error 1010).
    expect(headers["User-Agent"]).toMatch(/^cocalc-runpod\//);
  });

  it("never reveals the key through inspect or JSON", () => {
    const client = new RunpodClient({
      apiKey: KEY,
      fetch: fakeFetch([]).fetch,
    });
    expect(inspect(client)).not.toContain(KEY);
    expect(JSON.stringify(client)).not.toContain(KEY);
    expect(JSON.stringify({ client })).not.toContain("rpa_");
  });

  it("rejects a missing or malformed key", () => {
    expect(() => new RunpodClient({ apiKey: "" })).toThrow(/required/);
    expect(() => new RunpodClient({ apiKey: "a b" })).toThrow(/required/);
  });

  it("drops env, start commands and unknown fields from pods", async () => {
    const { fetch } = fakeFetch([
      {
        body: [
          {
            id: "abc123def456",
            name: "cc-7f3k9q2x",
            desiredStatus: "RUNNING",
            costPerHr: 0.27,
            env: { BOOTSTRAP: "secret-token", OTHER: KEY },
            dockerStartCmd: ["bash", "-c", "echo secret-token"],
            containerRegistryAuthId: "reg-1",
            templateId: "tmpl-1",
            consumerUserId: "user_1",
            machine: { gpuTypeId: "NVIDIA RTX A5000", dataCenterId: "EU-RO-1" },
            portMappings: { "22": 40022, bogus: 1 },
            somethingNew: "x",
          },
        ],
      },
    ]);
    const [pod] = await new RunpodClient({ apiKey: KEY, fetch }).listPods();
    expect(pod).toEqual({
      id: "abc123def456",
      name: "cc-7f3k9q2x",
      desiredStatus: "RUNNING",
      costPerHr: 0.27,
      gpuTypeId: "NVIDIA RTX A5000",
      dataCenterId: "EU-RO-1",
      portMappings: { "22": 40022 },
    });
    expect(JSON.stringify(pod)).not.toMatch(/secret-token|rpa_|reg-1|tmpl-1/);
  });

  it("scrubs keys and echoed request bodies from provider errors", async () => {
    const echoed = `{"error":"bad env","env":{"X":"${KEY}"},"auth":"Bearer ${KEY}"}${"x".repeat(500)}`;
    const { fetch } = fakeFetch([{ status: 400, body: echoed }]);
    const err = await new RunpodClient({ apiKey: KEY, fetch })
      .listPods()
      .catch((e) => e);
    expect(err).toBeInstanceOf(RunpodApiError);
    expect(err.status).toBe(400);
    expect(err.unauthorized).toBe(false);
    expect(err.message).not.toContain(KEY);
    expect(err.message.length).toBeLessThan(260);
  });

  it("flags a refused key so the caller can mark it unmanaged", async () => {
    const { fetch } = fakeFetch([{ status: 403, body: "" }]);
    const err = await new RunpodClient({ apiKey: KEY, fetch })
      .listPods()
      .catch((e) => e);
    expect(err.unauthorized).toBe(true);
  });

  it("treats a GraphQL UNAUTHORIZED error as a refused key", async () => {
    const { fetch } = fakeFetch([
      {
        body: {
          errors: [
            { message: "Unauthorized", extensions: { code: "UNAUTHORIZED" } },
          ],
        },
      },
    ]);
    const err = await new RunpodClient({ apiKey: KEY, fetch })
      .getAccount()
      .catch((e) => e);
    expect(err).toBeInstanceOf(RunpodApiError);
    expect(err.unauthorized).toBe(true);
  });

  it("does not leak the request when the network fails", async () => {
    const fetch = (async () => {
      throw new Error(`connect failed with Authorization: Bearer ${KEY}`);
    }) as unknown as typeof globalThis.fetch;
    const err = await new RunpodClient({ apiKey: KEY, fetch })
      .getAccount()
      .catch((e) => e);
    expect(err.message).toBe("RunPod request failed (Error)");
  });

  it("returns undefined for a pod that no longer exists", async () => {
    const { fetch } = fakeFetch([{ status: 404, body: "" }]);
    expect(
      await new RunpodClient({ apiKey: KEY, fetch }).getPod("abc123def456"),
    ).toBeUndefined();
  });

  it("refuses pod ids that could change the request path", async () => {
    const client = new RunpodClient({
      apiKey: KEY,
      fetch: fakeFetch([]).fetch,
    });
    await expect(client.getPod("../billing")).rejects.toThrow(/invalid/);
    await expect(client.listPodBilling({ podId: "a&b=c" })).rejects.toThrow(
      /invalid/,
    );
  });

  it("reads account balance and spend", async () => {
    const { fetch, calls } = fakeFetch([
      {
        body: {
          data: {
            myself: {
              id: "user_1",
              clientBalance: 30.17,
              currentSpendPerHr: 0.061,
              spendLimit: 80,
              underBalance: false,
            },
          },
        },
      },
    ]);
    const account = await new RunpodClient({ apiKey: KEY, fetch }).getAccount();
    expect(calls[0].url).toBe("https://api.runpod.io/graphql");
    expect(account).toEqual({
      id: "user_1",
      clientBalance: 30.17,
      currentSpendPerHr: 0.061,
      spendLimit: 80,
      underBalance: false,
    });
  });

  it("asks for per-pod billing records", async () => {
    const { fetch, calls } = fakeFetch([
      { body: [{ podId: "abc123def456", amount: 0.03, time: "t", extra: 1 }] },
    ]);
    const rows = await new RunpodClient({ apiKey: KEY, fetch }).listPodBilling({
      podId: "abc123def456",
    });
    expect(calls[0].url).toBe(
      "https://rest.runpod.io/v1/billing/pods?grouping=podId&bucketSize=hour&podId=abc123def456",
    );
    expect(rows).toEqual([{ podId: "abc123def456", amount: 0.03, time: "t" }]);
  });
});

describe("scrubText and podView", () => {
  it("redacts key-like strings and secret references", () => {
    expect(scrubText(`a ${KEY} b RUNPOD_SECRET_db c`)).toBe(
      "a [redacted] b [redacted] c",
    );
  });

  it("ignores rows that aren't pods", () => {
    expect(podView(null)).toBeUndefined();
    expect(podView({ name: "no id" })).toBeUndefined();
  });
});
