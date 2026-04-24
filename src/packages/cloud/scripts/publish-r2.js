#!/usr/bin/env node
"use strict";

/*
 * publish-r2.js
 *
 * Uploads a build artifact to Cloudflare R2 (S3-compatible) using SigV4.
 * - Uploads the file and a sibling .sha256 file.
 * - Optionally writes a "latest" manifest JSON (url, sha256, size, built_at, os, arch, version, message).
 * - Can also copy an existing object (e.g., staging -> latest) without
 *   uploading a new file.
 *
 * Required env:
 *   COCALC_R2_ACCOUNT_ID, COCALC_R2_ACCESS_KEY_ID, COCALC_R2_SECRET_ACCESS_KEY,
 *   COCALC_R2_BUCKET
 *   COCALC_R2_PUBLIC_BASE_URL (serving domain for public URLs, e.g., https://software.cocalc.ai)
 *
 * Optional env:
 *   COCALC_R2_PREFIX, COCALC_R2_LATEST_KEY,
 *   COCALC_R2_VERSIONS_KEY, COCALC_R2_VERSIONS_LIMIT,
 *   COCALC_R2_CACHE_CONTROL, COCALC_R2_LATEST_CACHE_CONTROL,
 *   COCALC_R2_COPY_FROM, COCALC_R2_COPY_TO
 *
 * Examples:
 *   node publish-r2.js --file ./artifact.tar.xz --bucket cocalc-artifacts \
 *     --prefix software/project-host/0.1.7 --latest-key software/project-host/latest-linux-amd64.json \
 *     --os linux --arch amd64 --version 0.1.7
 *   node publish-r2.js --bucket cocalc-artifacts \
 *     --copy-from software/project-host/staging.json \
 *     --copy-to software/project-host/latest.json
 */

const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const util = require("node:util");
const REQUEST_MAX_ATTEMPTS = 4;
const REQUEST_RETRY_BASE_DELAY_MS = 1000;
const UPLOAD_MAX_ATTEMPTS = 3;
const UPLOAD_RETRY_BASE_DELAY_MS = 5000;
const execFile = util.promisify(childProcess.execFile);

function usage() {
  console.error(
    "Usage: publish-r2.js --file <path> --bucket <bucket> [--key <key>] [--prefix <prefix>] [--public-base-url <url>] [--latest-key <key>] [--versions-key <key>] [--versions-limit <n>] [--os <os>] [--arch <arch>] [--version <semver>] [--message <text>] [--cache-control <value>] [--latest-cache-control <value>] [--copy-from <key> --copy-to <key>]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryOperation({
  label,
  maxAttempts,
  baseDelayMs,
  isRetryable,
  fn,
}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt === maxAttempts || !isRetryable(err)) {
        throw err;
      }
      const waitMs = baseDelayMs * attempt;
      process.stderr.write(
        `warning: ${label} failed on attempt ${attempt}/${maxAttempts}: ${err.message || err}; retrying in ${waitMs}ms\n`,
      );
      await delay(waitMs);
    }
  }
  throw new Error(`unreachable retry state for ${label}`);
}

function isRetryableRequestError(err) {
  const code = err?.code;
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
  const message = `${err?.message || err || ""}`;
  return (
    /bad record mac/i.test(message) ||
    /socket hang up/i.test(message) ||
    /Client network socket disconnected/i.test(message)
  );
}

async function sendRequest({
  method,
  host,
  path,
  headers,
  body,
  createBodyStream,
  label,
}) {
  for (let attempt = 1; attempt <= REQUEST_MAX_ATTEMPTS; attempt += 1) {
    const family = attempt >= 2 ? 4 : undefined;
    try {
      return await new Promise((resolve, reject) => {
        let bodyStream;
        const req = https.request(
          {
            method,
            host,
            path,
            headers,
            family,
          },
          (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
              resolve({
                statusCode: res.statusCode ?? 0,
                body: Buffer.concat(chunks),
              });
            });
          },
        );
        req.on("error", reject);
        if (body != null) {
          req.write(body);
          req.end();
          return;
        }
        if (createBodyStream) {
          bodyStream = createBodyStream();
          bodyStream.on("error", (err) => req.destroy(err));
          req.on("close", () => bodyStream.destroy());
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
      process.stderr.write(
        `warning: ${label} failed on attempt ${attempt}/${REQUEST_MAX_ATTEMPTS}: ${err.message || err}; retrying in ${waitMs}ms${attempt === 1 ? " with IPv4" : ""}\n`,
      );
      await delay(waitMs);
    }
  }
  throw new Error(`unreachable request state for ${label}`);
}

function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalizePath(bucket, key) {
  const parts = [bucket, ...key.split("/").filter(Boolean)];
  return `/${parts.map(encodeRfc3986).join("/")}`;
}

function hashHex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key, data, encoding) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest(encoding);
}

function getSignatureKey(secret, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function joinKey(prefix, filename) {
  if (!prefix) return filename;
  return `${prefix.replace(/\/+$/, "")}/${filename}`;
}

function deriveVersionsKeyFromLatestKey(latestKey) {
  if (!latestKey) return undefined;
  const match = latestKey.match(
    /^(software\/(?:project-host|project|tools)\/)(latest|staging)-([^/]+)\.json$/,
  );
  if (!match) return undefined;
  const [, prefix, channel, suffix] = match;
  return `${prefix}versions-${channel}-${suffix}.json`;
}

function parseVersionsKeyMetadata(key) {
  if (!key) return {};
  const match = key.match(
    /^software\/(project-host|project|tools)\/versions-(latest|staging)-([^.]+)\.json$/,
  );
  if (!match) return {};
  const [, artifact, channel, selector] = match;
  const parts = selector.split("-").filter(Boolean);
  const os = parts[0];
  const arch = parts.length > 1 ? parts.slice(1).join("-") : undefined;
  return { artifact, channel, os, arch };
}

function normalizeVersionsLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.max(1, Math.min(200, Math.floor(n)));
}

function normalizeVersionEntry(value) {
  if (!value || typeof value !== "object") return undefined;
  const url = typeof value.url === "string" ? value.url.trim() : "";
  const version = typeof value.version === "string" ? value.version.trim() : "";
  if (!url && !version) return undefined;
  const out = {};
  if (version) out.version = version;
  if (url) out.url = url;
  if (typeof value.sha256 === "string" && value.sha256.trim()) {
    out.sha256 = value.sha256.trim();
  }
  if (
    typeof value.size_bytes === "number" &&
    Number.isFinite(value.size_bytes) &&
    value.size_bytes >= 0
  ) {
    out.size_bytes = Math.floor(value.size_bytes);
  }
  if (typeof value.built_at === "string" && value.built_at.trim()) {
    out.built_at = value.built_at.trim();
  }
  if (typeof value.message === "string" && value.message.trim()) {
    out.message = value.message.trim();
  }
  return out;
}

function versionEntryKey(entry) {
  if (entry.version) return `v:${entry.version}`;
  if (entry.url) return `u:${entry.url}`;
  return "";
}

function extractVersion(raw) {
  if (!raw) return null;
  const match = raw.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return match ? match[1] : null;
}

function shouldUseCurlForUpload(filePath) {
  return (
    !!filePath &&
    process.platform === "darwin" &&
    process.env.COCALC_R2_DISABLE_CURL_UPLOAD !== "1"
  );
}

async function hashFile(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function putObject({
  host,
  region,
  accessKey,
  secretKey,
  bucket,
  key,
  body,
  filePath,
  contentLength,
  contentType,
  cacheControl,
  payloadHash,
  createBodyStream,
}) {
  const method = "PUT";
  const service = "s3";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const effectivePayloadHash = payloadHash ?? hashHex(body == null ? "" : body);
  const headers = {
    host,
    "x-amz-content-sha256": effectivePayloadHash,
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
  const canonicalUri = canonicalizePath(bucket, key);
  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    effectivePayloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hashHex(canonicalRequest),
  ].join("\n");
  const signingKey = getSignatureKey(secretKey, dateStamp, region, service);
  const signature = hmac(signingKey, stringToSign, "hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const requestHeaders = {
    ...headers,
    authorization,
    "content-length": contentLength ?? Buffer.byteLength(body),
  };

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
      method,
      "--upload-file",
      filePath,
    ];
    for (const [name, value] of Object.entries(requestHeaders)) {
      args.push("-H", `${name}: ${value}`);
    }
    args.push(`https://${host}${canonicalUri}`);
    try {
      await execFile("curl", args, {
        maxBuffer: 10 * 1024 * 1024,
      });
      return;
    } catch (err) {
      const detail =
        `${err?.stderr || err?.stdout || err?.message || err}`.trim();
      throw new Error(detail || `curl upload failed for ${key}`);
    }
  }

  const response = await sendRequest({
    method,
    host,
    path: canonicalUri,
    headers: requestHeaders,
    body,
    createBodyStream,
    label: `R2 PUT ${key}`,
  });
  if (response.statusCode >= 200 && response.statusCode < 300) {
    return;
  }
  throw new Error(
    `R2 PUT failed (${response.statusCode}): ${response.body.toString("utf8")}`,
  );
}

async function copyObject({
  host,
  region,
  accessKey,
  secretKey,
  bucket,
  sourceKey,
  destKey,
}) {
  const method = "PUT";
  const service = "s3";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = hashHex("");
  const copySource = canonicalizePath(bucket, sourceKey);
  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    "x-amz-copy-source": copySource,
  };

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${String(headers[name]).trim()}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalUri = canonicalizePath(bucket, destKey);
  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hashHex(canonicalRequest),
  ].join("\n");
  const signingKey = getSignatureKey(secretKey, dateStamp, region, service);
  const signature = hmac(signingKey, stringToSign, "hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const requestHeaders = {
    ...headers,
    authorization,
    "content-length": 0,
  };

  const response = await sendRequest({
    method,
    host,
    path: canonicalUri,
    headers: requestHeaders,
    label: `R2 COPY ${sourceKey} -> ${destKey}`,
  });
  if (response.statusCode >= 200 && response.statusCode < 300) {
    return;
  }
  throw new Error(
    `R2 COPY failed (${response.statusCode}): ${response.body.toString("utf8")}`,
  );
}

async function getObject({ host, region, accessKey, secretKey, bucket, key }) {
  const method = "GET";
  const service = "s3";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = hashHex("");
  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${String(headers[name]).trim()}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalUri = canonicalizePath(bucket, key);
  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hashHex(canonicalRequest),
  ].join("\n");
  const signingKey = getSignatureKey(secretKey, dateStamp, region, service);
  const signature = hmac(signingKey, stringToSign, "hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const requestHeaders = {
    ...headers,
    authorization,
  };

  const response = await sendRequest({
    method,
    host,
    path: canonicalUri,
    headers: requestHeaders,
    label: `R2 GET ${key}`,
  });
  if (response.statusCode === 404) {
    return undefined;
  }
  if (response.statusCode >= 200 && response.statusCode < 300) {
    return response.body;
  }
  throw new Error(
    `R2 GET failed (${response.statusCode}): ${response.body.toString("utf8")}`,
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const copyFrom = args["copy-from"] || process.env.COCALC_R2_COPY_FROM;
  const copyTo = args["copy-to"] || process.env.COCALC_R2_COPY_TO;
  const accountId = args["account-id"] || process.env.COCALC_R2_ACCOUNT_ID;
  const accessKey = args["access-key"] || process.env.COCALC_R2_ACCESS_KEY_ID;
  const secretKey =
    args["secret-key"] || process.env.COCALC_R2_SECRET_ACCESS_KEY;
  const bucket = args.bucket || process.env.COCALC_R2_BUCKET;
  if (!accountId || !accessKey || !secretKey || !bucket) {
    throw new Error(
      "Missing R2 credentials; set COCALC_R2_ACCOUNT_ID, COCALC_R2_ACCESS_KEY_ID, COCALC_R2_SECRET_ACCESS_KEY, and COCALC_R2_BUCKET.",
    );
  }

  const region = args.region || process.env.COCALC_R2_REGION || "auto";
  if (copyFrom || copyTo) {
    if (!copyFrom || !copyTo) {
      throw new Error("copy-from and copy-to must both be set");
    }
    const host = `${accountId}.r2.cloudflarestorage.com`;
    await copyObject({
      host,
      region,
      accessKey,
      secretKey,
      bucket,
      sourceKey: copyFrom,
      destKey: copyTo,
    });
    process.stdout.write(`copied ${copyFrom} -> ${copyTo}\n`);
    return;
  }

  const filePath = args.file || process.env.COCALC_R2_FILE;
  if (!filePath) {
    usage();
  }

  const prefix = args.prefix || process.env.COCALC_R2_PREFIX || "";
  const publicBaseUrl =
    args["public-base-url"] || process.env.COCALC_R2_PUBLIC_BASE_URL || "";
  const cacheControl =
    args["cache-control"] ||
    process.env.COCALC_R2_CACHE_CONTROL ||
    "public, max-age=31536000, immutable";
  const latestCacheControl =
    args["latest-cache-control"] ||
    process.env.COCALC_R2_LATEST_CACHE_CONTROL ||
    "public, max-age=300";
  const latestKey = args["latest-key"] || process.env.COCALC_R2_LATEST_KEY;
  const versionsKey =
    args["versions-key"] ||
    process.env.COCALC_R2_VERSIONS_KEY ||
    deriveVersionsKeyFromLatestKey(latestKey);
  const versionsLimit = normalizeVersionsLimit(
    args["versions-limit"] || process.env.COCALC_R2_VERSIONS_LIMIT || "50",
  );
  const manifestOs = args.os || process.env.COCALC_R2_OS;
  const manifestArch = args.arch || process.env.COCALC_R2_ARCH;
  const filename = path.basename(filePath);
  const key = args.key || joinKey(prefix, filename);
  const manifestVersion =
    args.version ||
    process.env.COCALC_R2_VERSION ||
    process.env.VERSION ||
    extractVersion(key) ||
    extractVersion(filename);
  const manifestMessage =
    `${args.message || process.env.COCALC_R2_MESSAGE || ""}`.trim() ||
    undefined;

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const contentType =
    args["content-type"] ||
    process.env.COCALC_R2_CONTENT_TYPE ||
    "application/octet-stream";

  const fileStat = fs.statSync(filePath);
  const fileHash = await hashFile(filePath);

  await retryOperation({
    label: `artifact upload ${key}`,
    maxAttempts: UPLOAD_MAX_ATTEMPTS,
    baseDelayMs: UPLOAD_RETRY_BASE_DELAY_MS,
    isRetryable: isRetryableRequestError,
    fn: async () =>
      await putObject({
        host,
        region,
        accessKey,
        secretKey,
        bucket,
        key,
        filePath,
        contentLength: fileStat.size,
        contentType,
        cacheControl,
        payloadHash: fileHash,
        createBodyStream: () => fs.createReadStream(filePath),
      }),
  });

  const shaBody = Buffer.from(`${fileHash}  ${filename}\n`, "utf8");
  await putObject({
    host,
    region,
    accessKey,
    secretKey,
    bucket,
    key: `${key}.sha256`,
    body: shaBody,
    contentType: "text/plain",
    cacheControl,
  });

  if (latestKey) {
    const urlBase = publicBaseUrl.replace(/\/+$/, "");
    const url = urlBase
      ? `${urlBase}/${key}`
      : `https://${host}/${bucket}/${key}`;
    const manifest = {
      url,
      sha256: fileHash,
      size_bytes: fileStat.size,
      built_at: new Date().toISOString(),
    };
    if (manifestOs) {
      manifest.os = manifestOs;
    }
    if (manifestArch) {
      manifest.arch = manifestArch;
    }
    if (manifestVersion) {
      manifest.version = manifestVersion;
    }
    if (manifestMessage) {
      manifest.message = manifestMessage;
    }
    const manifestBody = Buffer.from(JSON.stringify(manifest, null, 2));
    await putObject({
      host,
      region,
      accessKey,
      secretKey,
      bucket,
      key: latestKey,
      body: manifestBody,
      contentType: "application/json",
      cacheControl: latestCacheControl,
    });

    if (versionsKey) {
      const latestEntry = normalizeVersionEntry(manifest);
      if (latestEntry) {
        let previous = [];
        try {
          const existingBody = await getObject({
            host,
            region,
            accessKey,
            secretKey,
            bucket,
            key: versionsKey,
          });
          if (existingBody) {
            const parsed = JSON.parse(existingBody.toString("utf8"));
            const versions = Array.isArray(parsed?.versions)
              ? parsed.versions
              : Array.isArray(parsed)
                ? parsed
                : [];
            previous = versions.map(normalizeVersionEntry).filter((v) => !!v);
          }
        } catch (err) {
          process.stderr.write(
            `warning: failed reading existing versions index ${versionsKey}: ${err.message || err}\n`,
          );
        }
        const merged = [];
        const seen = new Set();
        for (const item of [latestEntry, ...previous]) {
          const k = versionEntryKey(item);
          if (!k || seen.has(k)) continue;
          seen.add(k);
          merged.push(item);
          if (merged.length >= versionsLimit) break;
        }
        const metadata = parseVersionsKeyMetadata(versionsKey);
        const index = {
          ...metadata,
          os: manifestOs || metadata.os,
          arch: manifestArch || metadata.arch,
          generated_at: new Date().toISOString(),
          versions: merged,
        };
        if (!index.artifact) delete index.artifact;
        if (!index.channel) delete index.channel;
        if (!index.os) delete index.os;
        if (!index.arch) delete index.arch;
        const versionsBody = Buffer.from(JSON.stringify(index, null, 2));
        await putObject({
          host,
          region,
          accessKey,
          secretKey,
          bucket,
          key: versionsKey,
          body: versionsBody,
          contentType: "application/json",
          cacheControl: latestCacheControl,
        });
      }
    }
  }

  process.stdout.write(`uploaded ${key}\n`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
