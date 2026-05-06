/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash, createHmac } from "node:crypto";
import childProcess from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import https from "node:https";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const REQUEST_MAX_ATTEMPTS = 4;
const REQUEST_RETRY_BASE_DELAY_MS = 1000;
const OBJECT_IO_MAX_ATTEMPTS = 3;
const OBJECT_IO_RETRY_BASE_DELAY_MS = 5000;
const execFile = promisify(childProcess.execFile);

export interface R2ObjectStoreAuth {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region?: string;
}

export type R2RequestMethod = "GET" | "PUT" | "POST" | "DELETE";

type R2QueryValue = string | number | boolean | undefined;

export type SignedR2Request = {
  parsed: URL;
  url: string;
  canonicalUri: string;
  canonicalQuery: string;
  headers: Record<string, string>;
};

type RequestResponse = {
  statusCode: number;
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
};

type RetryableError = Error & {
  code?: string;
  retryable?: boolean;
  statusCode?: number;
};

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryOperation<T>({
  label,
  maxAttempts,
  baseDelayMs,
  isRetryable,
  fn,
}: {
  label: string;
  maxAttempts: number;
  baseDelayMs: number;
  isRetryable: (err: unknown) => boolean;
  fn: (attempt: number) => Promise<T>;
}): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt === maxAttempts || !isRetryable(err)) {
        throw err;
      }
      const waitMs = baseDelayMs * attempt;
      await delay(waitMs);
    }
  }
  throw new Error(`unreachable retry state for ${label}`);
}

function isRetryableRequestError(err: unknown): boolean {
  const code = (err as RetryableError)?.code;
  if (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    code === "ENETUNREACH" ||
    code === "EHOSTUNREACH" ||
    code === "UND_ERR_SOCKET"
  ) {
    return true;
  }
  const message = `${(err as Error)?.message || err || ""}`;
  return (
    /bad record mac/i.test(message) ||
    /socket hang up/i.test(message) ||
    /Client network socket disconnected/i.test(message)
  );
}

function isRetryableObjectIoError(err: unknown): boolean {
  return (
    isRetryableRequestError(err) ||
    (typeof err === "object" &&
      err != null &&
      Boolean((err as RetryableError).retryable))
  );
}

function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalizePath(bucket: string, key: string): string {
  const parts = [bucket, ...`${key}`.split("/").filter(Boolean)];
  return `/${parts.map(encodeRfc3986).join("/")}`;
}

function canonicalizeQuery(
  query: Record<string, R2QueryValue> | undefined,
): string {
  const entries = Object.entries(query ?? {})
    .filter(([, value]) => value != null)
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(`${value}`)])
    .sort(([aKey, aValue], [bKey, bValue]) =>
      aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey),
    );
  return entries.map(([key, value]) => `${key}=${value}`).join("&");
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(
  key: string | Buffer,
  data: string,
  encoding?: "hex",
): Buffer | string {
  const hash = createHmac("sha256", key).update(data, "utf8");
  return encoding ? hash.digest(encoding) : hash.digest();
}

function getSignatureKey(
  secret: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp) as Buffer;
  const kRegion = hmac(kDate, region) as Buffer;
  const kService = hmac(kRegion, service) as Buffer;
  return hmac(kService, "aws4_request") as Buffer;
}

export function signR2Request({
  auth,
  method,
  key = "",
  payloadSha256,
  query,
  extraHeaders = {},
  bucketInPath = true,
}: {
  auth: R2ObjectStoreAuth;
  method: R2RequestMethod;
  key?: string;
  payloadSha256: string;
  query?: Record<string, R2QueryValue>;
  extraHeaders?: Record<string, string | number | undefined>;
  bucketInPath?: boolean;
}): SignedR2Request {
  const parsed = new URL(auth.endpoint);
  if (parsed.protocol !== "https:") {
    throw new Error("R2 endpoint must use https");
  }
  const endpointPath =
    parsed.pathname && parsed.pathname !== "/"
      ? parsed.pathname.replace(/\/+$/, "")
      : "";
  const host = parsed.host;
  const bucketPath = bucketInPath ? canonicalizePath(auth.bucket, key) : "/";
  const canonicalUri = `${endpointPath}${bucketPath}`;
  const canonicalQuery = canonicalizeQuery(query);
  const region = auth.region ?? "auto";
  const service = "s3";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadSha256,
    "x-amz-date": amzDate,
  };
  for (const [name, value] of Object.entries(extraHeaders)) {
    if (value == null) continue;
    headers[name.toLowerCase()] = `${value}`;
  }
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${String(headers[name]).trim()}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadSha256,
  ].join("\n");
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = getSignatureKey(
    auth.secretKey,
    dateStamp,
    region,
    service,
  );
  const signature = hmac(signingKey, stringToSign, "hex") as string;
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${auth.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return {
    parsed,
    url: `${parsed.origin}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`,
    canonicalUri,
    canonicalQuery,
    headers,
  };
}

function createHttpStatusError(
  statusCode: number,
  body: Buffer,
): RetryableError {
  const err = new Error(
    `R2 request failed (${statusCode}): ${body.toString("utf8")}`,
  ) as RetryableError;
  err.statusCode = statusCode;
  err.retryable = statusCode === 429 || statusCode >= 500;
  return err;
}

async function sendRequest({
  method,
  signed,
  body,
  createBodyStream,
  label,
}: {
  method: R2RequestMethod;
  signed: SignedR2Request;
  body?: Buffer;
  createBodyStream?: () => NodeJS.ReadableStream;
  label: string;
}): Promise<RequestResponse> {
  for (let attempt = 1; attempt <= REQUEST_MAX_ATTEMPTS; attempt += 1) {
    const family = attempt >= 2 ? 4 : undefined;
    try {
      return await new Promise((resolve, reject) => {
        const req = https.request(
          {
            method,
            protocol: signed.parsed.protocol,
            host: signed.parsed.hostname,
            port: signed.parsed.port ? Number(signed.parsed.port) : undefined,
            path: signed.canonicalQuery
              ? `${signed.canonicalUri}?${signed.canonicalQuery}`
              : signed.canonicalUri,
            headers: signed.headers,
            family,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) =>
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
            );
            res.on("end", () => {
              resolve({
                statusCode: res.statusCode ?? 0,
                body: Buffer.concat(chunks),
                headers: res.headers,
              });
            });
          },
        );
        req.on("error", reject);
        if (body != null) {
          req.end(body);
          return;
        }
        if (createBodyStream != null) {
          const bodyStream = createBodyStream();
          bodyStream.on("error", (err) => req.destroy(err));
          req.on("close", () => (bodyStream as any).destroy?.());
          bodyStream.pipe(req);
          return;
        }
        req.end();
      });
    } catch (err) {
      if (attempt === REQUEST_MAX_ATTEMPTS || !isRetryableRequestError(err)) {
        throw err;
      }
      const waitMs = REQUEST_RETRY_BASE_DELAY_MS * attempt;
      await delay(waitMs);
    }
  }
  throw new Error(`unreachable request state for ${label}`);
}

export async function sendR2Request({
  auth,
  method,
  key = "",
  query,
  payload,
  payloadSha256,
  extraHeaders = {},
  createBodyStream,
  bucketInPath = true,
  label,
}: {
  auth: R2ObjectStoreAuth;
  method: R2RequestMethod;
  key?: string;
  query?: Record<string, R2QueryValue>;
  payload?: Buffer | string;
  payloadSha256?: string;
  extraHeaders?: Record<string, string | number | undefined>;
  createBodyStream?: () => NodeJS.ReadableStream;
  bucketInPath?: boolean;
  label: string;
}): Promise<RequestResponse> {
  const bodyBuffer =
    payload == null
      ? undefined
      : Buffer.isBuffer(payload)
        ? payload
        : Buffer.from(payload);
  return await retryOperation({
    label,
    maxAttempts: OBJECT_IO_MAX_ATTEMPTS,
    baseDelayMs: OBJECT_IO_RETRY_BASE_DELAY_MS,
    isRetryable: isRetryableObjectIoError,
    fn: async () => {
      const signed = signR2Request({
        auth,
        method,
        key,
        query,
        payloadSha256:
          payloadSha256 ?? sha256Hex(bodyBuffer == null ? "" : bodyBuffer),
        extraHeaders,
        bucketInPath,
      });
      const response = await sendRequest({
        method,
        signed,
        body: bodyBuffer,
        createBodyStream,
        label,
      });
      if (response.statusCode === 429 || response.statusCode >= 500) {
        throw createHttpStatusError(response.statusCode, response.body);
      }
      return response;
    },
  });
}

function shouldUseCurlForUpload(filePath?: string): boolean {
  return (
    !!filePath &&
    process.platform === "darwin" &&
    process.env.COCALC_R2_DISABLE_CURL_UPLOAD !== "1"
  );
}

export async function putR2ObjectFromFile({
  auth,
  key,
  filePath,
  contentType,
  cacheControl,
  payloadSha256,
  contentLength,
}: {
  auth: R2ObjectStoreAuth;
  key: string;
  filePath: string;
  contentType?: string;
  cacheControl?: string;
  payloadSha256: string;
  contentLength?: number;
}): Promise<void> {
  await retryOperation({
    label: `R2 PUT ${key}`,
    maxAttempts: OBJECT_IO_MAX_ATTEMPTS,
    baseDelayMs: OBJECT_IO_RETRY_BASE_DELAY_MS,
    isRetryable: isRetryableObjectIoError,
    fn: async () => {
      const bytes = contentLength ?? (await stat(filePath)).size;
      const signed = signR2Request({
        auth,
        method: "PUT",
        key,
        payloadSha256,
        extraHeaders: {
          "content-type": contentType,
          "cache-control": cacheControl,
          "content-length": bytes,
        },
      });

      if (shouldUseCurlForUpload(filePath)) {
        const args = [
          "--fail-with-body",
          "--silent",
          "--show-error",
          "--http1.1",
          "--ipv4",
          "--retry",
          "4",
          "--retry-all-errors",
          "--retry-delay",
          "1",
          "--request",
          "PUT",
          "--upload-file",
          filePath,
        ];
        for (const [name, value] of Object.entries(signed.headers)) {
          args.push("-H", `${name}: ${value}`);
        }
        args.push("-H", `content-length: ${bytes}`);
        args.push(`${signed.parsed.origin}${signed.canonicalUri}`);
        try {
          await execFile("curl", args, { maxBuffer: 10 * 1024 * 1024 });
          return;
        } catch (err: any) {
          const detail =
            `${err?.stderr || err?.stdout || err?.message || err}`.trim();
          throw new Error(detail || `curl upload failed for ${key}`);
        }
      }

      const response = await sendRequest({
        method: "PUT",
        signed,
        createBodyStream: () => createReadStream(filePath),
        label: `R2 PUT ${key}`,
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw createHttpStatusError(response.statusCode, response.body);
      }
    },
  });
}

export async function getR2ObjectToFile({
  auth,
  key,
  outputPath,
}: {
  auth: R2ObjectStoreAuth;
  key: string;
  outputPath: string;
}): Promise<{ sha256: string; bytes: number }> {
  return await retryOperation({
    label: `R2 GET ${key}`,
    maxAttempts: OBJECT_IO_MAX_ATTEMPTS,
    baseDelayMs: OBJECT_IO_RETRY_BASE_DELAY_MS,
    isRetryable: isRetryableObjectIoError,
    fn: async () => {
      for (
        let requestAttempt = 1;
        requestAttempt <= REQUEST_MAX_ATTEMPTS;
        requestAttempt += 1
      ) {
        const signed = signR2Request({
          auth,
          method: "GET",
          key,
          payloadSha256: sha256Hex(""),
        });
        const hash = createHash("sha256");
        let bytes = 0;
        const family = requestAttempt >= 2 ? 4 : undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            const req = https.request(
              {
                method: "GET",
                protocol: signed.parsed.protocol,
                host: signed.parsed.hostname,
                port: signed.parsed.port
                  ? Number(signed.parsed.port)
                  : undefined,
                path: signed.canonicalUri,
                headers: signed.headers,
                family,
              },
              (res) => {
                const statusCode = res.statusCode ?? 0;
                if (statusCode < 200 || statusCode >= 300) {
                  const chunks: Buffer[] = [];
                  res.on("data", (chunk) =>
                    chunks.push(
                      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
                    ),
                  );
                  res.on("end", () =>
                    reject(
                      createHttpStatusError(statusCode, Buffer.concat(chunks)),
                    ),
                  );
                  return;
                }
                res.on("data", (chunk) => {
                  const buffer = Buffer.isBuffer(chunk)
                    ? chunk
                    : Buffer.from(chunk);
                  hash.update(buffer);
                  bytes += buffer.length;
                });
                const output = createWriteStream(outputPath);
                output.on("error", reject);
                res.on("error", reject);
                pipeline(res, output).then(() => resolve(), reject);
              },
            );
            req.on("error", reject);
            req.end();
          });
          return { sha256: hash.digest("hex"), bytes };
        } catch (err) {
          if (
            requestAttempt === REQUEST_MAX_ATTEMPTS ||
            !isRetryableRequestError(err)
          ) {
            throw err;
          }
          const waitMs = REQUEST_RETRY_BASE_DELAY_MS * requestAttempt;
          await delay(waitMs);
        }
      }
      throw new Error(`unreachable request state for R2 GET ${key}`);
    },
  });
}

export async function putR2ObjectFromBuffer({
  auth,
  key,
  body,
  contentType,
  cacheControl,
}: {
  auth: R2ObjectStoreAuth;
  key: string;
  body: Buffer | string;
  contentType?: string;
  cacheControl?: string;
}): Promise<void> {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const response = await sendR2Request({
    auth,
    method: "PUT",
    key,
    payload: buffer,
    extraHeaders: {
      "content-type": contentType,
      "cache-control": cacheControl,
      "content-length": buffer.length,
    },
    label: `R2 PUT ${key}`,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw createHttpStatusError(response.statusCode, response.body);
  }
}

export async function getR2ObjectBuffer({
  auth,
  key,
}: {
  auth: R2ObjectStoreAuth;
  key: string;
}): Promise<Buffer | undefined> {
  const response = await sendR2Request({
    auth,
    method: "GET",
    key,
    payloadSha256: sha256Hex(""),
    label: `R2 GET ${key}`,
  });
  if (response.statusCode === 404) {
    return undefined;
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw createHttpStatusError(response.statusCode, response.body);
  }
  return response.body;
}

export async function copyR2Object({
  auth,
  sourceKey,
  destKey,
}: {
  auth: R2ObjectStoreAuth;
  sourceKey: string;
  destKey: string;
}): Promise<void> {
  const response = await sendR2Request({
    auth,
    method: "PUT",
    key: destKey,
    payload: "",
    extraHeaders: {
      "x-amz-copy-source": canonicalizePath(auth.bucket, sourceKey),
      "content-length": 0,
    },
    label: `R2 COPY ${sourceKey} -> ${destKey}`,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw createHttpStatusError(response.statusCode, response.body);
  }
}

function decodeXmlEntity(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractXmlTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? decodeXmlEntity(match[1]) : null;
}

function extractXmlTags(xml: string, tag: string): string[] {
  const matches = xml.matchAll(
    new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"),
  );
  const values: string[] = [];
  for (const match of matches) {
    if (match[1] != null) {
      values.push(decodeXmlEntity(match[1]));
    }
  }
  return values;
}

export async function listR2ObjectKeys({
  auth,
  prefix,
}: {
  auth: R2ObjectStoreAuth;
  prefix?: string;
}): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  while (true) {
    const response = await sendR2Request({
      auth,
      method: "GET",
      key: "",
      query: {
        "list-type": "2",
        "encoding-type": "url",
        ...(prefix ? { prefix } : {}),
        ...(continuationToken
          ? { "continuation-token": continuationToken }
          : {}),
      },
      payloadSha256: sha256Hex(""),
      label: `R2 LIST ${prefix ?? ""}`,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw createHttpStatusError(response.statusCode, response.body);
    }
    const xml = response.body.toString("utf8");
    keys.push(
      ...extractXmlTags(xml, "Key").map((key) => decodeURIComponent(key)),
    );
    const isTruncated = extractXmlTag(xml, "IsTruncated") === "true";
    if (!isTruncated) {
      return keys;
    }
    continuationToken =
      extractXmlTag(xml, "NextContinuationToken") ?? undefined;
    if (!continuationToken) {
      throw new Error("R2 object list truncated without continuation token");
    }
  }
}

export async function deleteR2Object({
  auth,
  key,
  acceptMissing = true,
}: {
  auth: R2ObjectStoreAuth;
  key: string;
  acceptMissing?: boolean;
}): Promise<void> {
  const response = await sendR2Request({
    auth,
    method: "DELETE",
    key,
    payloadSha256: sha256Hex(""),
    label: `R2 DELETE ${key}`,
  });
  if (
    response.statusCode === 204 ||
    response.statusCode === 200 ||
    response.statusCode === 202 ||
    (acceptMissing && response.statusCode === 404)
  ) {
    return;
  }
  throw createHttpStatusError(response.statusCode, response.body);
}

function parseBucketNamesFromListBucketsXml(xml: string): string[] {
  const scope = /<Buckets>([\s\S]*?)<\/Buckets>/i.exec(xml)?.[1] ?? xml;
  const names: string[] = [];
  const re = /<Name>([^<]+)<\/Name>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(scope)) != null) {
    const name = `${match[1] ?? ""}`.trim();
    if (name) names.push(name);
  }
  return [...new Set(names)];
}

export async function listR2BucketsViaS3({
  endpoint,
  accessKey,
  secretKey,
  region = "auto",
}: {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  region?: string;
}): Promise<string[]> {
  const response = await sendR2Request({
    auth: {
      endpoint,
      accessKey,
      secretKey,
      bucket: "",
      region,
    },
    method: "GET",
    bucketInPath: false,
    payloadSha256: sha256Hex(""),
    label: "R2 LIST BUCKETS",
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw createHttpStatusError(response.statusCode, response.body);
  }
  return parseBucketNamesFromListBucketsXml(response.body.toString("utf8"));
}
