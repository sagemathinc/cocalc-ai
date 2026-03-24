/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import https from "node:https";

type SignedRequest = {
  parsed: URL;
  canonicalUri: string;
  canonicalQuery: string;
  headers: Record<string, string>;
};

type MultipartAuth = {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  key: string;
};

type UploadPartInput = MultipartAuth & {
  uploadId: string;
  partNumber: number;
  filePath: string;
  start: number;
  endInclusive: number;
};

function hashHex(data: string | Buffer): string {
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

function getSignatureKey(secret: string, dateStamp: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp) as Buffer;
  const kRegion = hmac(kDate, "auto") as Buffer;
  const kService = hmac(kRegion, "s3") as Buffer;
  return hmac(kService, "aws4_request") as Buffer;
}

function toAmzDate(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalizeObjectPath(bucket: string, key: string): string {
  const parts = [bucket, ...`${key ?? ""}`.split("/").filter(Boolean)];
  return `/${parts.map(encodeRfc3986).join("/")}`;
}

function canonicalQueryString(
  query: Record<string, string | number | boolean | undefined>,
): string {
  return Object.entries(query)
    .filter(([, value]) => value != null)
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(`${value}`)])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function signedRequest({
  method,
  endpoint,
  accessKey,
  secretKey,
  bucket,
  key,
  payloadSha256,
  query = {},
  extraHeaders = {},
}: MultipartAuth & {
  method: "POST" | "PUT" | "DELETE";
  payloadSha256: string;
  query?: Record<string, string | number | boolean | undefined>;
  extraHeaders?: Record<string, string | number | undefined>;
}): SignedRequest {
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "https:") {
    throw new Error("R2 endpoint must use https");
  }
  const host = parsed.host;
  const canonicalUri = canonicalizeObjectPath(bucket, key);
  const canonicalQuery = canonicalQueryString(query);
  const now = new Date();
  const amzDate = toAmzDate(now);
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
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hashHex(canonicalRequest),
  ].join("\n");
  const signingKey = getSignatureKey(secretKey, dateStamp);
  const signature = hmac(signingKey, stringToSign, "hex") as string;
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { parsed, canonicalUri, canonicalQuery, headers };
}

function xmlTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^<]+)</${tag}>`, "i").exec(xml);
  return match?.[1]?.trim();
}

async function requestText({
  auth,
  method,
  query,
  payload = "",
  extraHeaders = {},
}: {
  auth: MultipartAuth;
  method: "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  payload?: Buffer | string;
  extraHeaders?: Record<string, string | number | undefined>;
}): Promise<{
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}> {
  const bodyBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const signed = signedRequest({
    ...auth,
    method,
    payloadSha256: hashHex(bodyBuffer),
    query,
    extraHeaders,
  });
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
        headers: {
          ...signed.headers,
          "content-length": bodyBuffer.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(bodyBuffer);
  });
}

export async function beginMultipartUpload(
  auth: MultipartAuth,
): Promise<{ uploadId: string }> {
  const response = await requestText({
    auth,
    method: "POST",
    query: { uploads: "" },
    payload: "",
    extraHeaders: { "content-type": "application/octet-stream" },
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `R2 multipart begin failed (${response.statusCode}): ${response.body}`,
    );
  }
  const uploadId = xmlTag(response.body, "UploadId");
  if (!uploadId) {
    throw new Error("R2 multipart begin response did not include UploadId");
  }
  return { uploadId };
}

export async function uploadMultipartPartFromFile(
  input: UploadPartInput,
): Promise<{ partNumber: number; etag: string }> {
  const partSize = input.endInclusive - input.start + 1;
  if (partSize <= 0) {
    throw new Error("multipart part size must be positive");
  }
  const signed = signedRequest({
    ...input,
    method: "PUT",
    payloadSha256: "UNSIGNED-PAYLOAD",
    query: {
      partNumber: input.partNumber,
      uploadId: input.uploadId,
    },
  });
  return await new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: "PUT",
        protocol: signed.parsed.protocol,
        host: signed.parsed.hostname,
        port: signed.parsed.port ? Number(signed.parsed.port) : undefined,
        path: signed.canonicalQuery
          ? `${signed.canonicalUri}?${signed.canonicalQuery}`
          : signed.canonicalUri,
        headers: {
          ...signed.headers,
          "content-length": partSize,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        res.on("end", () => {
          if (
            !res.statusCode ||
            res.statusCode < 200 ||
            res.statusCode >= 300
          ) {
            reject(
              new Error(
                `R2 multipart upload part ${input.partNumber} failed (${res.statusCode}): ${Buffer.concat(chunks).toString("utf8")}`,
              ),
            );
            return;
          }
          const etagHeader = res.headers.etag;
          const etag = Array.isArray(etagHeader) ? etagHeader[0] : etagHeader;
          if (!etag) {
            reject(
              new Error(
                `R2 multipart upload part ${input.partNumber} did not return ETag`,
              ),
            );
            return;
          }
          resolve({
            partNumber: input.partNumber,
            etag: etag.replace(/^"+|"+$/g, ""),
          });
        });
      },
    );
    req.on("error", reject);
    createReadStream(input.filePath, {
      start: input.start,
      end: input.endInclusive,
    })
      .on("error", reject)
      .pipe(req);
  });
}

export async function completeMultipartUpload({
  auth,
  uploadId,
  parts,
}: {
  auth: MultipartAuth;
  uploadId: string;
  parts: Array<{ partNumber: number; etag: string }>;
}): Promise<void> {
  const body = [
    "<CompleteMultipartUpload>",
    ...parts
      .slice()
      .sort((a, b) => a.partNumber - b.partNumber)
      .map(
        ({ partNumber, etag }) =>
          `<Part><PartNumber>${partNumber}</PartNumber><ETag>"${etag}"</ETag></Part>`,
      ),
    "</CompleteMultipartUpload>",
  ].join("");
  const response = await requestText({
    auth,
    method: "POST",
    query: { uploadId },
    payload: body,
    extraHeaders: { "content-type": "application/xml" },
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `R2 multipart complete failed (${response.statusCode}): ${response.body}`,
    );
  }
}

export async function abortMultipartUpload({
  auth,
  uploadId,
}: {
  auth: MultipartAuth;
  uploadId: string;
}): Promise<void> {
  const response = await requestText({
    auth,
    method: "DELETE",
    query: { uploadId },
    payload: "",
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `R2 multipart abort failed (${response.statusCode}): ${response.body}`,
    );
  }
}
