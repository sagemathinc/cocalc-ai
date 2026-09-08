import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { reconcileCloudflareBlobs } from "./cloudflare-blob-reconcile";
import { blobWorkerSource } from "./cloudflare-blob-worker-source";

const account = "a".repeat(32);
const zone = "b".repeat(32);
const apiRoot = "https://api.cloudflare.com/client/v4/";
const root = `accounts/${account}`;
const script = `${root}/workers/scripts/test-blob-images`;
const domain = "blobs.example.com";
const savedSettings = {
  project_hosts_cloudflare_tunnel_api_token: "durable-secret",
  project_hosts_cloudflare_tunnel_account_id: account,
  r2_account_id: account,
  r2_access_key_id: "s3-access",
  r2_secret_access_key: "s3-secret",
  r2_bucket_prefix: "test",
  dns: "example.com",
};
const workerFetch = new Function(
  blobWorkerSource
    .replace("export async function", "async function")
    .replace("export default", "return"),
)().fetch;

function harness(overrides: Record<string, any> = {}) {
  const settings = { ...savedSettings, ...overrides };
  const bucket = settings.blob_r2_bucket || "test-blobs";
  const bucketPath = `${root}/r2/buckets/${bucket}`;
  const state = {
    bucket: false,
    managed: true,
    custom: [] as { enabled: boolean }[],
    worker: undefined as any,
    domains: [] as any[],
    dns: [] as any[],
    objects: new Map<string, Buffer>(),
    uploads: [] as FormData[],
    calls: [] as { path: string; method: string }[],
    fail: "",
    corruptS3: false,
    corruptWorker: false,
    failHead: false,
    zoneAccount: account,
    extraDomainPage: false,
    redirectStatus: 302,
    wrongLocation: false,
  };
  const json = (result: unknown) =>
    new Response(JSON.stringify({ success: true, result }), {
      headers: { "Content-Type": "application/json" },
    });
  const fetchMock = jest
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = new URL(`${input}`);
      const method = init?.method || "GET";
      expect(init?.signal).toBeDefined();
      if (url.hostname === "example.com") {
        expect(method).toBe("HEAD");
        expect(init?.redirect).toBe("manual");
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        expect(url.pathname).toBe("/blobs/cloudflare-probe.png");
        const uuid = url.searchParams.get("uuid")!;
        expect(
          state.objects.has(`/${bucket}/blobs/v1/${uuid.slice(0, 2)}/${uuid}`),
        ).toBe(true);
        expect(settings.blob_r2_public_url).toBe(`https://${domain}`);
        state.calls.push({ path: "same-origin", method });
        if (state.fail === "same-origin")
          throw new Error("durable-secret upstream failure");
        return new Response(null, {
          status: state.redirectStatus,
          headers: {
            Location: state.wrongLocation
              ? "https://wrong.example.com/secret"
              : `https://${domain}/${uuid}`,
          },
        });
      }
      expect(init?.redirect).toBe("error");
      if (`${input}`.startsWith(apiRoot)) {
        const path = `${input}`.slice(apiRoot.length).split("?")[0];
        state.calls.push({ path, method });
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer durable-secret",
        );
        if (state.fail === `${method} ${path}`)
          return new Response("durable-secret s3-secret upstream-error", {
            status: 403,
          });
        if (path === "zones")
          return json([
            {
              id: zone,
              name: "example.com",
              account: { id: state.zoneAccount },
            },
          ]);
        if (path === `${script}/settings`)
          return state.worker
            ? json(state.worker)
            : new Response("missing", { status: 404 });
        if (path === `${root}/workers/domains`) {
          if (method === "GET") {
            expect(url.searchParams.get("hostname")).toBe(domain);
            if (state.extraDomainPage && url.searchParams.get("page") === "1")
              return new Response(
                JSON.stringify({
                  success: true,
                  result: [],
                  result_info: { total_pages: 2 },
                }),
              );
            return json(state.domains);
          }
          expect(method).toBe("PUT");
          const body = JSON.parse(init!.body as string);
          expect(body).toEqual({
            hostname: domain,
            service: "test-blob-images",
            zone_id: zone,
            environment: "production",
          });
          state.domains = [body];
          return json(body);
        }
        if (path === `zones/${zone}/dns_records`) return json(state.dns);
        if (path === bucketPath)
          return state.bucket
            ? json({ name: bucket })
            : new Response("missing", { status: 404 });
        if (path === `${root}/r2/buckets`) {
          expect(method).toBe("POST");
          expect(JSON.parse(init!.body as string)).toEqual({
            name: bucket,
            storage_class: "Standard",
          });
          state.bucket = true;
          return json({ name: bucket });
        }
        if (path === `${bucketPath}/domains/managed`) {
          if (method === "PUT") {
            expect(JSON.parse(init!.body as string)).toEqual({
              enabled: false,
            });
            state.managed = false;
          }
          return json({ enabled: state.managed });
        }
        if (path === `${bucketPath}/domains/custom`)
          return json({ domains: state.custom });
        if (path === script && method === "PUT") {
          expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
          const form = init!.body as FormData;
          state.uploads.push(form);
          state.worker = JSON.parse(
            await (form.get("metadata") as Blob).text(),
          );
          expect(state.worker.bindings).toEqual([
            { type: "r2_bucket", name: "BLOBS", bucket_name: bucket },
          ]);
          expect(state.worker.main_module).toBe("worker.mjs");
          expect(await (form.get("worker.mjs") as Blob).text()).toBe(
            blobWorkerSource,
          );
          expect((form.get("worker.mjs") as Blob).type).toBe(
            "application/javascript+module",
          );
          return json({ id: "test-blob-images" });
        }
        throw new Error(`Unexpected API ${method} ${path}`);
      }
      if (url.hostname === `${account}.r2.cloudflarestorage.com`) {
        state.calls.push({ path: "s3", method });
        expect(new Headers(init?.headers).get("authorization")).toContain(
          "AWS4-HMAC-SHA256 Credential=s3-access/",
        );
        const key = url.pathname;
        expect(key).toMatch(
          new RegExp(`^/${bucket}/blobs/v1/[a-f0-9]{2}/[a-f0-9-]{36}$`),
        );
        if (state.fail === `${method} s3`)
          return new Response("s3-secret", { status: 403 });
        if (method === "PUT")
          state.objects.set(key, Buffer.from(init!.body as Buffer));
        if (method === "DELETE") state.objects.delete(key);
        return new Response(
          method === "GET"
            ? state.corruptS3
              ? Buffer.from("bad")
              : state.objects.get(key)
            : null,
        );
      }
      expect(url.hostname).toBe(domain);
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      state.calls.push({ path: "worker", method });
      if (
        state.fail === `${method} worker` ||
        (method === "HEAD" && state.failHead)
      )
        return new Response(null, { status: 503 });
      const result = await workerFetch(new Request(url, { method }), {
        BLOBS: {
          get: async (key: string) => {
            const body = state.objects.get(`/${bucket}/${key}`);
            return body
              ? {
                  body: state.corruptWorker ? Buffer.from("bad") : body,
                  writeHttpMetadata: (headers: Headers) =>
                    headers.set("Content-Type", "image/png"),
                }
              : null;
          },
        },
      });
      return result;
    });
  const save = jest.fn(async (values: Record<string, string>) => {
    expect(state.objects.size).toBe(1);
    expect(state.calls).toContainEqual({ path: "worker", method: "HEAD" });
    Object.assign(settings, values);
  });
  return {
    state,
    settings,
    save,
    fetchMock,
    run: () => reconcileCloudflareBlobs({ settings, save }),
  };
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test("packaged Worker matches the checked-in deployable source byte for byte", () => {
  expect(blobWorkerSource).toBe(
    readFileSync(
      resolve(
        __dirname,
        "../../../scripts/cloudflare/cocalc-blob-image-router/worker.mjs",
      ),
      "utf8",
    ),
  );
});

test("provisions private R2, multipart Worker/custom domain, verifies exact bytes and HEAD, then saves", async () => {
  const h = harness();
  expect(await h.run()).toEqual({
    ok: true,
    bucket: "test-blobs",
    worker: "test-blob-images",
    public_url: `https://${domain}`,
    message: "Cloudflare blobs are healthy; same-origin redirect confirmed.",
  });
  expect(h.state.managed).toBe(false);
  expect(h.save).toHaveBeenCalledTimes(1);
  expect(h.save).toHaveBeenCalledWith({
    blob_r2_bucket: "test-blobs",
    blob_r2_public_url: `https://${domain}`,
    blob_storage_backend: "auto",
  });
  expect(
    h.state.calls.filter((c) => c.path === "s3").map((c) => c.method),
  ).toEqual(["PUT", "GET", "DELETE"]);
  expect(h.state.calls.slice(-2)).toEqual([
    { path: "same-origin", method: "HEAD" },
    { path: "s3", method: "DELETE" },
  ]);
  expect(h.state.objects.size).toBe(0);
});

test("respects an existing bucket override and retries without recreating resources", async () => {
  const h = harness({ blob_r2_bucket: "custom-image-bucket" });
  h.state.bucket = true;
  expect((await h.run()).ok).toBe(true);
  expect((await h.run()).ok).toBe(true);
  expect(h.state.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  expect(
    h.state.calls.filter(
      (c) => c.method === "PUT" && c.path === `${root}/workers/domains`,
    ),
  ).toHaveLength(1);
  expect(h.state.calls.some((c) => c.path.includes("tokens"))).toBe(false);
});

test("supports the settings/save positional API", async () => {
  const h = harness();
  expect((await reconcileCloudflareBlobs(h.settings, h.save)).ok).toBe(true);
});

test.each([
  [`PUT ${root}/workers/domains`, "hostname attachment"],
  ["PUT s3", "S3 write probe"],
  ["GET s3", "S3 read probe"],
  ["GET worker", "Worker GET probe"],
  ["HEAD worker", "Worker HEAD probe"],
  ["DELETE s3", "probe cleanup"],
])("reports a safe phase for %s", async (failure, phase) => {
  const h = harness();
  h.state.fail = failure;
  const result = await h.run();
  expect(result.ok).toBe(false);
  expect(result.message).toContain(`during ${phase}.`);
  expect(result.message).not.toMatch(/durable-secret|s3-secret/);
});

test("ownership tags recover deployment/domain creation before an interrupted settings save", async () => {
  const h = harness();
  h.save.mockRejectedValueOnce(new Error("s3-secret callback"));
  expect((await h.run()).ok).toBe(false);
  expect(h.settings).not.toHaveProperty("blob_r2_public_url");
  expect((await h.run()).ok).toBe(true);
});

test("ownership tags recover an upload followed by a failed domain attachment", async () => {
  const h = harness();
  h.state.fail = `PUT ${root}/workers/domains`;
  expect((await h.run()).ok).toBe(false);
  expect(h.save).not.toHaveBeenCalled();
  h.state.fail = "";
  expect((await h.run()).ok).toBe(true);
});

test.each(["worker", "domain", "dns", "public bucket", "zone account"])(
  "refuses foreign or public resources: %s",
  async (kind) => {
    const h = harness();
    if (kind === "worker") h.state.worker = { tags: ["foreign"] };
    if (kind === "domain") {
      h.state.domains = [
        { hostname: domain, service: "foreign", zone_id: zone },
      ];
      h.state.extraDomainPage = true;
    }
    if (kind === "dns") h.state.dns = [{ name: domain, type: "CNAME" }];
    if (kind === "public bucket") h.state.custom = [{ enabled: true }];
    if (kind === "zone account") h.state.zoneAccount = "c".repeat(32);
    expect((await h.run()).ok).toBe(false);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.state.uploads).toHaveLength(0);
  },
);

test("a disabled custom bucket domain is not public exposure", async () => {
  const h = harness();
  h.state.custom = [{ enabled: false }];
  expect((await h.run()).ok).toBe(true);
});

test.each(["s3", "worker", "head"])(
  "health failure (%s) cleans probe and never activates",
  async (kind) => {
    const h = harness({
      blob_storage_backend: "postgres",
      blob_r2_public_url: "https://previous.example.com",
    });
    h.state.corruptS3 = kind === "s3";
    h.state.corruptWorker = kind === "worker";
    h.state.failHead = kind === "head";
    expect((await h.run()).ok).toBe(false);
    expect(h.state.objects.size).toBe(0);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.settings.blob_storage_backend).toBe("postgres");
    expect(h.settings.blob_r2_public_url).toBe("https://previous.example.com");
  },
);

test.each([
  `GET ${script}/settings`,
  `PUT ${script}`,
  `PUT ${root}/r2/buckets/test-blobs/domains/managed`,
  "PUT s3",
  "GET s3",
  "GET worker",
  "HEAD worker",
])("sanitizes upstream failures and never saves on %s", async (failure) => {
  const h = harness();
  h.state.fail = failure;
  const result = await h.run();
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toMatch(
    /durable-secret|s3-secret|upstream-error/,
  );
  expect(h.save).not.toHaveBeenCalled();
  expect(h.state.objects.size).toBe(0);
});

test.each(["stale", "wrong location", "network", "other redirect"])(
  "same-origin %s is an advisory pending confirmation after activation",
  async (kind) => {
    const h = harness();
    if (kind === "stale") h.state.redirectStatus = 404;
    if (kind === "wrong location") h.state.wrongLocation = true;
    if (kind === "network") h.state.fail = "same-origin";
    if (kind === "other redirect") h.state.redirectStatus = 301;
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain("confirmation is pending");
    expect(result.message).not.toMatch(/durable-secret|wrong.example.com/);
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.state.objects.size).toBe(0);
    h.state.redirectStatus = 302;
    h.state.wrongLocation = false;
    h.state.fail = "";
    expect((await h.run()).message).toContain("redirect confirmed");
  },
);

test("cleanup failure after settings save is reported without undoing activation", async () => {
  const h = harness();
  h.state.fail = "DELETE s3";
  const result = await h.run();
  expect(result.ok).toBe(false);
  expect(result.message).toContain("probe cleanup");
  expect(h.save).toHaveBeenCalledTimes(1);
  expect(h.settings.blob_storage_backend).toBe("auto");
});

test("a stalled same-origin check times out with a pending warning and cleans up", async () => {
  jest.useFakeTimers();
  const h = harness();
  const normalFetch = h.fetchMock.getMockImplementation()!;
  h.fetchMock.mockImplementation(async (input, init) => {
    if (new URL(`${input}`).hostname === "example.com") {
      return await new Promise((_, reject) =>
        init!.signal!.addEventListener("abort", () =>
          reject(new Error("secret timeout")),
        ),
      );
    }
    return normalFetch(input, init);
  });
  const pending = h.run();
  await jest.runAllTimersAsync();
  const result = await pending;
  expect(result.ok).toBe(true);
  expect(result.message).toContain("confirmation is pending");
  expect(result.message).not.toContain("secret timeout");
  expect(h.save).toHaveBeenCalledTimes(1);
  expect(h.state.objects.size).toBe(0);
});

test.each([
  "project_hosts_cloudflare_tunnel_api_token",
  "r2_access_key_id",
  "r2_secret_access_key",
  "r2_bucket_prefix",
  "dns",
])("missing %s does not perform network operations", async (field) => {
  const h = harness({ [field]: "" });
  expect((await h.run()).ok).toBe(false);
  expect(h.fetchMock).not.toHaveBeenCalled();
  expect(h.save).not.toHaveBeenCalled();
});

test("rejects mismatched R2 account before networking", async () => {
  const h = harness({ r2_account_id: "c".repeat(32) });
  expect((await h.run()).ok).toBe(false);
  expect(h.fetchMock).not.toHaveBeenCalled();
});

test("aborts a stalled Worker response body, cleans the probe, and does not save", async () => {
  jest.useFakeTimers();
  const h = harness();
  const normalFetch = h.fetchMock.getMockImplementation()!;
  h.fetchMock.mockImplementation(async (input, init) => {
    if (`${input}`.startsWith(`https://${domain}/`)) {
      return {
        status: 200,
        headers: new Headers({
          "content-type": "image/png",
          etag: `"${new URL(`${input}`).pathname.slice(1)}"`,
          "x-content-type-options": "nosniff",
        }),
        arrayBuffer: () =>
          new Promise((_, reject) =>
            init!.signal!.addEventListener("abort", () =>
              reject(new Error("secret timeout")),
            ),
          ),
      } as Response;
    }
    return normalFetch(input, init);
  });
  const result = h.run();
  await jest.runAllTimersAsync();
  expect((await result).ok).toBe(false);
  expect(h.state.objects.size).toBe(0);
  expect(h.save).not.toHaveBeenCalled();
});
