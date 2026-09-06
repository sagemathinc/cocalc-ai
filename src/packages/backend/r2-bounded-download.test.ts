import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { getR2ObjectToFile, putR2ObjectFromFile } from "./r2";

let dir: string;
let request: jest.SpyInstance;
let response: Readable;
const auth = {
  endpoint: "https://example.test",
  accessKey: "test",
  secretKey: "test",
  bucket: "test",
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "r2-bounded-test-"));
});
afterEach(async () => {
  request?.mockRestore();
  response?.destroy();
  await rm(dir, { recursive: true, force: true });
});

function respond(parts: Buffer[] | null, status = 200, headers = {}) {
  response = parts == null ? new PassThrough() : Readable.from(parts);
  Object.assign(response, { statusCode: status, headers });
  request = jest.spyOn(https, "request").mockImplementation(((
    opts: any,
    callback: any,
  ) => {
    const req = new PassThrough();
    const abort = () => {
      const error = new Error("request aborted");
      req.destroy(error);
      response.destroy(error);
    };
    opts.signal?.addEventListener("abort", abort, { once: true });
    response.on("close", () =>
      opts.signal?.removeEventListener("abort", abort),
    );
    req.on("finish", () => callback(response));
    return req;
  }) as any);
}

function download(maxBytes?: number, signal?: AbortSignal) {
  return getR2ObjectToFile({
    auth,
    key: "report",
    outputPath: join(dir, "report"),
    maxBytes,
    signal,
  });
}

it("accepts exactly the limit and hashes the bytes actually written", async () => {
  const bytes = Buffer.from("abcdef");
  respond([bytes.subarray(0, 2), bytes.subarray(2)]);
  expect(await download(6)).toEqual({
    bytes: 6,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  expect(await readFile(join(dir, "report"))).toEqual(bytes);
});

it.each([{}, { "content-length": "1" }, { "content-length": "1000000000000" }])(
  "bounds actual bytes regardless of declared headers %j",
  async (headers) => {
    respond([Buffer.alloc(4), Buffer.alloc(4)], 200, headers);
    await expect(download(6)).rejects.toThrow("byte limit");
    expect((await stat(join(dir, "report"))).size).toBeLessThanOrEqual(6);
    expect(request).toHaveBeenCalledTimes(1);
    expect(response.destroyed).toBe(true);
  },
);

it("rejects an oversized single chunk before any of it reaches disk", async () => {
  respond([Buffer.alloc(128 * 1024)]);
  await expect(download(16)).rejects.toThrow("byte limit");
  expect((await stat(join(dir, "report"))).size).toBe(0);
});

it("bounds HTTP error bodies without retrying an unbounded response", async () => {
  respond([Buffer.alloc(128 * 1024)], 500);
  await expect(download(16)).rejects.toThrow(
    "error response exceeds byte limit",
  );
  expect(request).toHaveBeenCalledTimes(1);
  await expect(stat(join(dir, "report"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("cancels a stalled response", async () => {
  respond(null);
  await expect(download(16, AbortSignal.timeout(20))).rejects.toThrow();
  expect(response.destroyed).toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
});

it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid byte limit %s before connecting",
  async (maxBytes) => {
    respond([]);
    await expect(download(maxBytes)).rejects.toThrow(
      "Invalid R2 download byte limit",
    );
    expect(request).not.toHaveBeenCalled();
  },
);

it("supports empty objects with a zero-byte budget", async () => {
  respond([]);
  expect((await download(0)).bytes).toBe(0);
});

it("preserves the legacy optional-budget behavior", async () => {
  respond([Buffer.from("legacy")]);
  expect((await download()).bytes).toBe(6);
});

it("rejects pre-aborted uploads before stat or opening a connection", async () => {
  respond([]);
  await expect(
    putR2ObjectFromFile({
      auth,
      key: "report",
      filePath: "/missing",
      payloadSha256: "a".repeat(64),
      signal: AbortSignal.abort(),
    }),
  ).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
