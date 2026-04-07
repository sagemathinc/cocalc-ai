import getLogger from "@cocalc/backend/logger";
import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import https from "node:https";

const logger = getLogger("server:project-backup:r2");

const R2_REGIONS = ["wnam", "enam", "weur", "eeur", "apac", "oc"] as const;
const ENSURE_TTL_MS = 60 * 60 * 1000;

let lastEnsureAt = 0;
let ensureInFlight: Promise<void> | null = null;
let warnedMissingToken = false;

type CloudflareResponse<T> = {
  success: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
};

async function cloudflareRequest<T>(
  token: string,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(
      `cloudflare api failed: ${response.status} ${response.statusText}`,
    );
  }
  const payload = (await response.json()) as CloudflareResponse<T>;
  if (!payload.success) {
    const error = payload.errors?.[0]?.message ?? "unknown error";
    throw new Error(`cloudflare api failed: ${error}`);
  }
  if (payload.result == null) {
    throw new Error("cloudflare api returned no result");
  }
  return payload.result;
}

export async function listBuckets(
  token: string,
  accountId: string,
): Promise<string[]> {
  const result = await cloudflareRequest<
    { name: string }[] | { buckets: { name: string }[] }
  >(token, `accounts/${accountId}/r2/buckets`);
  if (Array.isArray(result)) {
    return result.map((bucket) => bucket.name);
  }
  return result.buckets.map((bucket) => bucket.name);
}

export type R2BucketInfo = {
  name: string;
  location?: string;
  creation_date?: string;
  jurisdiction?: string;
  storage_class?: string;
};

export type R2CredentialCheck = {
  ok: boolean;
  error?: string;
  bucket_count?: number;
};

export type R2CredentialsTestResult = {
  ok: boolean;
  checked_at: string;
  account_id: string;
  endpoint: string;
  bucket_prefix?: string;
  api_token: R2CredentialCheck;
  s3: R2CredentialCheck;
  matched_buckets: string[];
  notes: string[];
};

export type TestR2CredentialsInput = {
  accountId?: string;
  apiToken?: string;
  accessKey?: string;
  secretKey?: string;
  bucketPrefix?: string;
  endpoint?: string;
};

export async function createBucket(
  token: string,
  accountId: string,
  name: string,
  location: string,
): Promise<R2BucketInfo> {
  return await cloudflareRequest<R2BucketInfo>(
    token,
    `accounts/${accountId}/r2/buckets`,
    {
      method: "POST",
      body: JSON.stringify({ name, locationHint: location }),
    },
  );
}

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

function canonicalizeQuery(query?: Record<string, string | undefined>): string {
  const entries = Object.entries(query ?? {})
    .filter(([, value]) => value != null)
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(`${value}`)])
    .sort(([aKey, aValue], [bKey, bValue]) =>
      aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey),
    );
  return entries.map(([key, value]) => `${key}=${value}`).join("&");
}

function signedObjectHeaders({
  method = "PUT",
  endpoint,
  accessKey,
  secretKey,
  bucket,
  key,
  payloadSha256,
  contentType,
  cacheControl,
  query,
}: {
  method?: "PUT" | "GET" | "DELETE";
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  key: string;
  payloadSha256: string;
  contentType?: string;
  cacheControl?: string;
  query?: Record<string, string | undefined>;
}): {
  url: string;
  canonicalUri: string;
  headers: Record<string, string>;
} {
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "https:") {
    throw new Error("R2 endpoint must use https");
  }
  const host = parsed.host;
  const canonicalUri = canonicalizeObjectPath(bucket, key);
  const canonicalQuery = canonicalizeQuery(query);
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadSha256,
    "x-amz-date": amzDate,
  };
  if (contentType) {
    headers["content-type"] = contentType;
  }
  if (cacheControl) {
    headers["cache-control"] = cacheControl;
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
  return {
    url: `${parsed.origin}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`,
    canonicalUri,
    headers,
  };
}

export function issueSignedObjectDownload({
  endpoint,
  accessKey,
  secretKey,
  bucket,
  key,
}: {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  key: string;
}): { url: string; headers: Record<string, string> } {
  const { url, headers } = signedObjectHeaders({
    method: "GET",
    endpoint,
    accessKey,
    secretKey,
    bucket,
    key,
    payloadSha256: hashHex(""),
  });
  const { host: _host, ...requestHeaders } = headers;
  return { url, headers: requestHeaders };
}

export function issueSignedObjectUpload({
  endpoint,
  accessKey,
  secretKey,
  bucket,
  key,
  contentType,
  cacheControl,
  unsignedPayload = true,
}: {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  key: string;
  contentType?: string;
  cacheControl?: string;
  unsignedPayload?: boolean;
}): { url: string; headers: Record<string, string> } {
  const { url, headers } = signedObjectHeaders({
    method: "PUT",
    endpoint,
    accessKey,
    secretKey,
    bucket,
    key,
    payloadSha256: unsignedPayload ? "UNSIGNED-PAYLOAD" : hashHex(""),
    contentType,
    cacheControl,
  });
  const { host: _host, ...requestHeaders } = headers;
  return { url, headers: requestHeaders };
}

export async function uploadObjectFromFile({
  endpoint,
  accessKey,
  secretKey,
  bucket,
  key,
  filePath,
  artifactSha256,
  artifactBytes,
  contentType,
  cacheControl,
}: {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  key: string;
  filePath: string;
  artifactSha256: string;
  artifactBytes: number;
  contentType?: string;
  cacheControl?: string;
}): Promise<void> {
  const { url, canonicalUri, headers } = signedObjectHeaders({
    method: "PUT",
    endpoint,
    accessKey,
    secretKey,
    bucket,
    key,
    payloadSha256: artifactSha256,
    contentType,
    cacheControl,
  });
  const parsed = new URL(url);
  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        method: "PUT",
        protocol: parsed.protocol,
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : undefined,
        path: canonicalUri,
        headers: {
          ...headers,
          "content-length": artifactBytes,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
            return;
          }
          reject(
            new Error(
              `R2 PUT failed (${res.statusCode}): ${Buffer.concat(chunks).toString("utf8")}`,
            ),
          );
        });
      },
    );
    req.on("error", reject);
    createReadStream(filePath).on("error", reject).pipe(req);
  });
}

export async function uploadObjectFromBuffer({
  endpoint,
  accessKey,
  secretKey,
  bucket,
  key,
  body,
  contentType,
  cacheControl,
}: {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  key: string;
  body: Buffer | string;
  contentType?: string;
  cacheControl?: string;
}): Promise<void> {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const { url, canonicalUri, headers } = signedObjectHeaders({
    method: "PUT",
    endpoint,
    accessKey,
    secretKey,
    bucket,
    key,
    payloadSha256: hashHex(buffer),
    contentType,
    cacheControl,
  });
  const parsed = new URL(url);
  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        method: "PUT",
        protocol: parsed.protocol,
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : undefined,
        path: canonicalUri,
        headers: {
          ...headers,
          "content-length": buffer.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
            return;
          }
          reject(
            new Error(
              `R2 PUT failed (${res.statusCode}): ${Buffer.concat(chunks).toString("utf8")}`,
            ),
          );
        });
      },
    );
    req.on("error", reject);
    req.end(buffer);
  });
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

export async function listObjects({
  endpoint,
  accessKey,
  secretKey,
  bucket,
  prefix,
}: {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  prefix?: string;
}): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  while (true) {
    const { url, headers } = signedObjectHeaders({
      method: "GET",
      endpoint,
      accessKey,
      secretKey,
      bucket,
      key: "",
      payloadSha256: hashHex(""),
      query: {
        "list-type": "2",
        "encoding-type": "url",
        ...(prefix ? { prefix } : {}),
        ...(continuationToken
          ? { "continuation-token": continuationToken }
          : {}),
      },
    });
    const { host: _host, ...requestHeaders } = headers;
    const response = await fetch(url, { headers: requestHeaders });
    if (!response.ok) {
      throw new Error(
        `R2 object list failed (${response.status}): ${response.statusText || "unknown error"}`,
      );
    }
    const xml = await response.text();
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

export async function deleteObject({
  endpoint,
  accessKey,
  secretKey,
  bucket,
  key,
}: {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  key: string;
}): Promise<void> {
  const { url, canonicalUri, headers } = signedObjectHeaders({
    method: "DELETE",
    endpoint,
    accessKey,
    secretKey,
    bucket,
    key,
    payloadSha256: hashHex(""),
  });
  const parsed = new URL(url);
  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        method: "DELETE",
        protocol: parsed.protocol,
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : undefined,
        path: canonicalUri,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        res.on("end", () => {
          if (
            res.statusCode &&
            (res.statusCode === 204 ||
              res.statusCode === 200 ||
              res.statusCode === 202 ||
              res.statusCode === 404)
          ) {
            resolve();
            return;
          }
          reject(
            new Error(
              `R2 DELETE failed (${res.statusCode}): ${Buffer.concat(chunks).toString("utf8")}`,
            ),
          );
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
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

async function listBucketsViaS3({
  endpoint,
  accessKey,
  secretKey,
}: {
  endpoint: string;
  accessKey: string;
  secretKey: string;
}): Promise<string[]> {
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "https:") {
    throw new Error("R2 endpoint must use https");
  }
  const host = parsed.host;
  const method = "GET";
  const canonicalUri = "/";
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = hashHex("");
  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${String((headers as any)[name]).trim()}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
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
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await new Promise<{ statusCode?: number; body: string }>(
    (resolve, reject) => {
      const req = https.request(
        {
          method,
          protocol: parsed.protocol,
          host: parsed.hostname,
          port: parsed.port ? Number(parsed.port) : undefined,
          path: canonicalUri,
          headers: {
            ...headers,
            authorization,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) =>
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
          );
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      req.on("error", reject);
      req.end();
    },
  );

  const code = response.statusCode ?? 0;
  if (code < 200 || code >= 300) {
    throw new Error(`s3 list buckets failed (${code}): ${response.body}`);
  }
  return parseBucketNamesFromListBucketsXml(response.body);
}

function clean(v?: string): string | undefined {
  const s = `${v ?? ""}`.trim();
  return s.length > 0 ? s : undefined;
}

export async function testR2Credentials(
  opts: TestR2CredentialsInput,
): Promise<R2CredentialsTestResult> {
  const accountId = clean(opts.accountId) ?? "";
  const apiToken = clean(opts.apiToken);
  const accessKey = clean(opts.accessKey);
  const secretKey = clean(opts.secretKey);
  const bucketPrefix = clean(opts.bucketPrefix);
  const endpoint =
    clean(opts.endpoint) ??
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");

  const result: R2CredentialsTestResult = {
    ok: true,
    checked_at: new Date().toISOString(),
    account_id: accountId,
    endpoint,
    bucket_prefix: bucketPrefix,
    api_token: { ok: false },
    s3: { ok: false },
    matched_buckets: [],
    notes: [],
  };

  let apiBuckets: string[] = [];
  let s3Buckets: string[] = [];

  if (!accountId) {
    result.ok = false;
    result.api_token = { ok: false, error: "missing r2_account_id" };
    result.s3 = { ok: false, error: "missing r2_account_id" };
    return result;
  }

  if (!endpoint) {
    result.ok = false;
    result.s3 = { ok: false, error: "missing R2 endpoint" };
  }

  if (!apiToken) {
    result.ok = false;
    result.api_token = { ok: false, error: "missing r2_api_token" };
  } else {
    try {
      apiBuckets = await listBuckets(apiToken, accountId);
      result.api_token = {
        ok: true,
        bucket_count: apiBuckets.length,
      };
    } catch (err) {
      result.ok = false;
      result.api_token = { ok: false, error: `${err}` };
    }
  }

  if (!accessKey) {
    result.ok = false;
    result.s3 = { ok: false, error: "missing r2_access_key_id" };
  } else if (!secretKey) {
    result.ok = false;
    result.s3 = { ok: false, error: "missing r2_secret_access_key" };
  } else if (!endpoint) {
    result.ok = false;
    result.s3 = { ok: false, error: "missing endpoint" };
  } else {
    try {
      s3Buckets = await listBucketsViaS3({
        endpoint,
        accessKey,
        secretKey,
      });
      result.s3 = {
        ok: true,
        bucket_count: s3Buckets.length,
      };
    } catch (err) {
      result.ok = false;
      result.s3 = { ok: false, error: `${err}` };
    }
  }

  const source = apiBuckets.length > 0 ? apiBuckets : s3Buckets;
  if (bucketPrefix) {
    result.matched_buckets = source
      .filter((name) => name.startsWith(`${bucketPrefix}-`))
      .sort();
    if (result.matched_buckets.length === 0) {
      result.notes.push(`No buckets currently match prefix '${bucketPrefix}'.`);
    }
  }

  return result;
}

export async function ensureR2Buckets(opts: {
  accountId?: string;
  bucketPrefix?: string;
  apiToken?: string;
}) {
  const accountId = opts.accountId?.trim();
  const bucketPrefix = opts.bucketPrefix?.trim();
  const apiToken = opts.apiToken?.trim();
  if (!accountId || !bucketPrefix) return;
  if (!apiToken) {
    if (!warnedMissingToken) {
      warnedMissingToken = true;
      logger.warn("r2_api_token is missing; skipping bucket creation");
    }
    return;
  }
  const now = Date.now();
  if (now - lastEnsureAt < ENSURE_TTL_MS) return;
  if (ensureInFlight) return ensureInFlight;

  ensureInFlight = (async () => {
    try {
      const existing = new Set(await listBuckets(apiToken, accountId));
      for (const region of R2_REGIONS) {
        const name = `${bucketPrefix}-${region}`;
        if (existing.has(name)) continue;
        try {
          await createBucket(apiToken, accountId, name, region);
          logger.info("r2 bucket created", { name, region });
        } catch (err) {
          logger.warn("r2 bucket creation failed", {
            name,
            region,
            err: `${err}`,
          });
        }
      }
    } catch (err) {
      logger.warn("r2 bucket ensure failed", { err: `${err}` });
    } finally {
      lastEnsureAt = Date.now();
      ensureInFlight = null;
    }
  })();

  return ensureInFlight;
}
