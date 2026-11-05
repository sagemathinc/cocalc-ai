/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// copyR2Object against an in-memory S3: single CopyObject for small objects,
// UploadPartCopy for larger ones, abort on a failed part.

import { EventEmitter } from "node:events";

type Call = { method: string; key: string; query: URLSearchParams };

const objects = new Map<string, Buffer>();
const uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
const calls: Call[] = [];
let failPart: number | undefined;
let completeError = false;
let shortComplete = false;
let badEtag = false;
let keepAlive = 0;

function respond(
  method: string,
  key: string,
  query: URLSearchParams,
  headers: Record<string, string>,
  body: Buffer,
): { status: number; body?: string; headers?: Record<string, string> } {
  const copySource = headers["x-amz-copy-source"];
  const source = copySource
    ? objects.get(decodeURIComponent(copySource.split("/").slice(2).join("/")))
    : undefined;
  if (method === "HEAD") {
    const obj = objects.get(key);
    return obj
      ? {
          status: 200,
          headers: { "content-length": `${obj.length}`, etag: '"x"' },
        }
      : { status: 404 };
  }
  if (method === "POST" && query.has("uploads")) {
    const id = `upload-${uploads.size + 1}`;
    uploads.set(id, { key, parts: new Map() });
    return {
      status: 200,
      body: `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
    };
  }
  if (method === "PUT" && query.has("partNumber")) {
    const n = Number(query.get("partNumber"));
    if (n === failPart) return { status: 403, body: "<Error>denied</Error>" };
    if (badEtag) {
      return {
        status: 200,
        body: "<CopyPartResult><ETag>&quot;a&lt;b&quot;</ETag></CopyPartResult>",
      };
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(
      headers["x-amz-copy-source-range"],
    );
    if (!source || !range) return { status: 400 };
    uploads
      .get(query.get("uploadId")!)!
      .parts.set(n, source.subarray(Number(range[1]), Number(range[2]) + 1));
    return {
      status: 200,
      body: `<CopyPartResult><ETag>&quot;${n.toString(16).padStart(8, "0")}&quot;</ETag></CopyPartResult>`,
    };
  }
  if (method === "POST" && query.has("uploadId")) {
    if (completeError) {
      return { status: 200, body: "<Error><Code>InternalError</Code></Error>" };
    }
    const upload = uploads.get(query.get("uploadId")!)!;
    const numbers = [
      ...body
        .toString()
        .matchAll(
          /<PartNumber>(\d+)<\/PartNumber><ETag>"([0-9a-f]+)"<\/ETag>/g,
        ),
    ];
    const joined = Buffer.concat(
      numbers.map((m) => upload.parts.get(Number(m[1]))!),
    );
    objects.set(upload.key, shortComplete ? joined.subarray(1) : joined);
    uploads.delete(query.get("uploadId")!);
    return { status: 200, body: "<CompleteMultipartUploadResult/>" };
  }
  if (method === "DELETE" && query.has("uploadId")) {
    uploads.delete(query.get("uploadId")!);
    return { status: 204 };
  }
  if (method === "PUT" && copySource) {
    if (!source) return { status: 404 };
    objects.set(key, Buffer.from(source));
    return { status: 200, body: "<CopyObjectResult/>" };
  }
  return { status: 400 };
}

jest.mock("node:https", () => ({
  __esModule: true,
  default: {
    request: (opts: any, cb: (res: any) => void) => {
      const req: any = new EventEmitter();
      const chunks: Buffer[] = [];
      req.destroy = () => undefined;
      req.write = (chunk: Buffer) => chunks.push(Buffer.from(chunk));
      req.end = (chunk?: Buffer) => {
        if (chunk) chunks.push(Buffer.from(chunk));
        const url = new URL(`https://r2.example.com${opts.path}`);
        const key = decodeURIComponent(
          url.pathname.split("/").slice(2).join("/"),
        );
        calls.push({ method: opts.method, key, query: url.searchParams });
        const out = respond(
          opts.method,
          key,
          url.searchParams,
          opts.headers,
          Buffer.concat(chunks),
        );
        const res: any = new EventEmitter();
        res.statusCode = out.status;
        res.headers = out.headers ?? {};
        setImmediate(() => {
          cb(res);
          if (out.body) res.emit("data", Buffer.from(out.body));
          res.emit("end");
        });
      };
      setImmediate(() =>
        req.emit("socket", { setKeepAlive: () => (keepAlive += 1) }),
      );
      return req;
    },
  },
}));

import { copyR2Object, R2_COPY_LIMITS } from "./r2";

const auth = {
  endpoint: "https://r2.example.com",
  accessKey: "a",
  secretKey: "s",
  bucket: "bucket",
};
const limits = { ...R2_COPY_LIMITS };

beforeEach(() => {
  objects.clear();
  uploads.clear();
  calls.length = 0;
  failPart = undefined;
  completeError = false;
  shortComplete = false;
  badEtag = false;
  // tiny test objects are copied in tiny parts
  Object.assign(R2_COPY_LIMITS, limits, { minPartSizeBytes: 1 });
});

afterAll(() => Object.assign(R2_COPY_LIMITS, limits));

const copyBig = (partSizeBytes: number) =>
  copyR2Object({
    auth,
    sourceKey: "src/big",
    destKey: "dst/big",
    partSizeBytes,
  });

describe("copyR2Object", () => {
  it("copies a small object with one CopyObject", async () => {
    objects.set("src/small", Buffer.from("abc"));
    await copyR2Object({
      auth,
      sourceKey: "src/small",
      destKey: "dst/small",
      partSizeBytes: 4,
    });
    expect(objects.get("dst/small")?.toString()).toBe("abc");
    expect(calls.filter((c) => c.query.has("partNumber"))).toHaveLength(0);
    expect(keepAlive).toBeGreaterThan(0);
  });

  it("copies a larger object in parts, in order", async () => {
    objects.set("src/big", Buffer.from("0123456789"));
    await copyR2Object({
      auth,
      sourceKey: "src/big",
      destKey: "dst/big",
      partSizeBytes: 4,
    });
    expect(objects.get("dst/big")?.toString()).toBe("0123456789");
    expect(calls.filter((c) => c.query.has("partNumber"))).toHaveLength(3);
    expect(uploads.size).toBe(0);
  });

  it("aborts the upload when a part fails", async () => {
    objects.set("src/big", Buffer.from("0123456789"));
    failPart = 2;
    await expect(
      copyR2Object({
        auth,
        sourceKey: "src/big",
        destKey: "dst/big",
        partSizeBytes: 4,
      }),
    ).rejects.toThrow(/403/);
    expect(objects.has("dst/big")).toBe(false);
    expect(
      calls.some((c) => c.method === "DELETE" && c.query.has("uploadId")),
    ).toBe(true);
    expect(uploads.size).toBe(0);
  });

  it("rejects a completion reported as 200 with an <Error> body, and aborts", async () => {
    objects.set("src/big", Buffer.from("0123456789"));
    completeError = true;
    await expect(copyBig(4)).rejects.toThrow(/InternalError/);
    expect(objects.has("dst/big")).toBe(false);
    expect(
      calls.some((c) => c.method === "DELETE" && c.query.has("uploadId")),
    ).toBe(true);
  });

  it("rejects a part ETag that is not hex, and aborts", async () => {
    objects.set("src/big", Buffer.from("0123456789"));
    badEtag = true;
    await expect(copyBig(4)).rejects.toThrow(/no valid ETag/);
    expect(
      calls.some((c) => c.method === "DELETE" && c.query.has("uploadId")),
    ).toBe(true);
  });

  it("rejects when the destination size differs from the source", async () => {
    objects.set("src/big", Buffer.from("0123456789"));
    shortComplete = true;
    await expect(copyBig(4)).rejects.toThrow(
      /destination size 9 != source size 10/,
    );
  });

  it.each([0, -4, NaN, Infinity, 2.5])(
    "refuses partSizeBytes %p before any request",
    async (partSizeBytes) => {
      objects.set("src/big", Buffer.from("0123456789"));
      await expect(copyBig(partSizeBytes)).rejects.toThrow(/positive integer/);
      expect(calls).toHaveLength(0);
    },
  );

  it("refuses parts below the minimum before beginning an upload", async () => {
    objects.set("src/big", Buffer.from("0123456789"));
    R2_COPY_LIMITS.minPartSizeBytes = 5;
    await expect(copyBig(4)).rejects.toThrow(/cannot be copied in parts/);
    expect(calls.some((c) => c.query.has("uploads"))).toBe(false);
  });

  it("uses larger parts when the requested size would need too many", async () => {
    objects.set("src/big", Buffer.from("0123456789"));
    R2_COPY_LIMITS.maxParts = 2;
    await copyBig(3);
    expect(objects.get("dst/big")?.toString()).toBe("0123456789");
    expect(calls.filter((c) => c.query.has("partNumber"))).toHaveLength(2);
  });

  it("refuses an object that needs parts above the maximum", async () => {
    objects.set("src/big", Buffer.from("0123456789"));
    Object.assign(R2_COPY_LIMITS, { maxParts: 2, maxPartSizeBytes: 4 });
    await expect(copyBig(3)).rejects.toThrow(/cannot be copied in parts/);
    expect(calls.some((c) => c.query.has("uploads"))).toBe(false);
  });

  it("keeps the production limits valid for R2", () => {
    expect(limits).toEqual({
      minPartSizeBytes: 5 * 1024 * 1024,
      maxPartSizeBytes: 5 * 1024 * 1024 * 1024,
      maxParts: 10_000,
    });
  });

  it("refuses a missing source", async () => {
    await expect(
      copyR2Object({ auth, sourceKey: "src/none", destKey: "dst/none" }),
    ).rejects.toThrow(/does not exist/);
  });
});
