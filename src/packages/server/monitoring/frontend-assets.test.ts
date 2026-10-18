import {
  frontendAssetMonitoringEnabled,
  parseFrontendAssetHistory,
  probeFrontendAssets,
} from "./frontend-assets";

test("disables frontend asset paging in development and test by default", () => {
  expect(frontendAssetMonitoringEnabled({ nodeEnv: "production" })).toBe(true);
  expect(frontendAssetMonitoringEnabled({ nodeEnv: "" })).toBe(true);
  expect(frontendAssetMonitoringEnabled({ nodeEnv: "development" })).toBe(
    false,
  );
  expect(frontendAssetMonitoringEnabled({ nodeEnv: "test" })).toBe(false);
  expect(
    frontendAssetMonitoringEnabled({
      nodeEnv: "development",
      configured: "true",
    }),
  ).toBe(true);
  expect(
    frontendAssetMonitoringEnabled({
      nodeEnv: "production",
      configured: "false",
    }),
  ).toBe(false);
});

test("parses current and previous safe content-addressed assets", () => {
  expect(
    parseFrontendAssetHistory({
      schema: 1,
      builds: [
        { assets: ["app-0123456789abcdef.js"] },
        { assets: ["app-fedcba9876543210.js"] },
      ],
    }),
  ).toEqual({
    builds: 2,
    assets: ["app-0123456789abcdef.js", "app-fedcba9876543210.js"],
  });
  expect(() =>
    parseFrontendAssetHistory({
      schema: 1,
      builds: [{ assets: ["../app-0123456789abcdef.js"] }],
    }),
  ).toThrow("unsafe path");
});

test("counts shared retained assets once while preserving the unique limit", () => {
  const assets = Array.from(
    { length: 10001 },
    (_, i) => `chunk-${i}-0123456789abcdef.js`,
  );
  expect(
    parseFrontendAssetHistory({
      schema: 1,
      builds: [{ assets }, { assets: [...assets] }],
    }),
  ).toEqual({ builds: 2, assets });
  expect(() =>
    parseFrontendAssetHistory({
      schema: 1,
      builds: [{ assets }, { assets: assets.map((asset) => `other-${asset}`) }],
    }),
  ).toThrow("frontend asset history exceeds 12000 files");
});

test("frontend asset history cap is 12000 unique files (prod: 10067, then 11175)", () => {
  const chunk = (i: number) => `chunk-${i}-0123456789abcdef.js`;
  const prod = Array.from({ length: 10067 }, (_, i) => chunk(i));
  expect(
    parseFrontendAssetHistory({
      schema: 1,
      builds: [{ assets: prod.slice(0, 1115) }, { assets: prod }],
    }).assets,
  ).toHaveLength(10067);
  // h5 as measured on prod: a mostly rehashed build over the retained set.
  const h5 = Array.from({ length: 11175 }, (_, i) => chunk(i));
  expect(
    parseFrontendAssetHistory({
      schema: 1,
      builds: [{ assets: h5.slice(10067) }, { assets: h5.slice(0, 10067) }],
    }).assets,
  ).toHaveLength(11175);
  const atCap = Array.from({ length: 12000 }, (_, i) => chunk(i));
  expect(
    parseFrontendAssetHistory({ schema: 1, builds: [{ assets: atCap }] })
      .assets,
  ).toHaveLength(12000);
  expect(() =>
    parseFrontendAssetHistory({
      schema: 1,
      builds: [{ assets: atCap }, { assets: [chunk(12000)] }],
    }),
  ).toThrow("frontend asset history exceeds 12000 files");
});

test("retries and reports unavailable retained assets", async () => {
  const requests: { method: string; url: string }[] = [];
  const fetchImpl = jest.fn(async (input, init) => {
    const url = `${input}`;
    const method = `${init?.method}`;
    requests.push({ method, url });
    if (url.includes("frontend-build-history.json")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          schema: 1,
          builds: [{ assets: ["app-0123456789abcdef.js"] }],
        }),
      } as Response;
    }
    return { ok: false, status: 404 } as Response;
  }) as typeof fetch;

  await expect(
    probeFrontendAssets({ origin: "https://example.test", fetchImpl }),
  ).resolves.toEqual({
    origin: "https://example.test",
    builds: 1,
    assets: 1,
    failures: ["app-0123456789abcdef.js: HTTP 404"],
  });
  expect(requests.map(({ method }) => method)).toEqual(["GET", "HEAD", "HEAD"]);
});

test("retries a transient missing frontend history", async () => {
  const requests: string[] = [];
  let historyRequests = 0;
  const fetchImpl = jest.fn(async (input, init) => {
    requests.push(`${init?.method} ${input}`);
    if (`${input}`.includes("frontend-build-history.json")) {
      historyRequests += 1;
      if (historyRequests === 1) {
        return { ok: false, status: 404 } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          schema: 1,
          builds: [{ assets: ["app-0123456789abcdef.js"] }],
        }),
      } as Response;
    }
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;

  await expect(
    probeFrontendAssets({
      origin: "https://example.test",
      fetchImpl,
      historyRetryDelayMs: 0,
    }),
  ).resolves.toEqual({
    origin: "https://example.test",
    builds: 1,
    assets: 1,
    failures: [],
  });
  expect(requests.map((request) => request.split(" ")[0])).toEqual([
    "GET",
    "GET",
    "HEAD",
  ]);
  expect(new URL(requests[0].slice(4)).search).not.toBe(
    new URL(requests[1].slice(4)).search,
  );
});

test("reports a frontend history that remains missing", async () => {
  const fetchImpl = jest.fn(
    async () => ({ ok: false, status: 404 }) as Response,
  ) as typeof fetch;

  await expect(
    probeFrontendAssets({
      origin: "https://example.test",
      fetchImpl,
      historyRetryDelayMs: 0,
    }),
  ).rejects.toThrow("frontend asset history returned HTTP 404");
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});
