import getLogger from "@cocalc/backend/logger";
import {
  deleteR2Object,
  deleteR2ObjectsConcurrently,
  listR2BucketsViaS3,
  listR2ObjectKeys,
  putR2ObjectFromBuffer,
  putR2ObjectFromFile,
  sha256Hex,
  signR2Request,
} from "@cocalc/backend/r2";

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
  result_info?: {
    page?: number;
    total_pages?: number;
  };
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
  const names: string[] = [];
  let page = 1;
  while (page <= 100) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets?${new URLSearchParams(
        { page: `${page}`, per_page: "100" },
      ).toString()}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );
    if (!response.ok) {
      throw new Error(
        `cloudflare api failed: ${response.status} ${response.statusText}`,
      );
    }
    const payload = (await response.json()) as CloudflareResponse<
      { name: string }[] | { buckets: { name: string }[] }
    >;
    if (!payload.success) {
      const error = payload.errors?.[0]?.message ?? "unknown error";
      throw new Error(`cloudflare api failed: ${error}`);
    }
    const result = payload.result;
    if (result == null) {
      throw new Error("cloudflare api returned no result");
    }
    const buckets = Array.isArray(result) ? result : (result.buckets ?? []);
    names.push(...buckets.map((bucket) => bucket.name));
    const totalPages = payload.result_info?.total_pages ?? page;
    if (page >= totalPages) break;
    page += 1;
  }
  return [...new Set(names)];
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
  const { url, headers } = signR2Request({
    auth: {
      endpoint,
      accessKey,
      secretKey,
      bucket,
      region: "auto",
    },
    method: "GET",
    key,
    payloadSha256: sha256Hex(""),
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
  const { url, headers } = signR2Request({
    auth: {
      endpoint,
      accessKey,
      secretKey,
      bucket,
      region: "auto",
    },
    method: "PUT",
    key,
    payloadSha256: unsignedPayload ? "UNSIGNED-PAYLOAD" : sha256Hex(""),
    extraHeaders: {
      "content-type": contentType,
      "cache-control": cacheControl,
    },
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
  await putR2ObjectFromFile({
    auth: {
      endpoint,
      accessKey,
      secretKey,
      bucket,
      region: "auto",
    },
    key,
    filePath,
    payloadSha256: artifactSha256,
    contentLength: artifactBytes,
    contentType,
    cacheControl,
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
  await putR2ObjectFromBuffer({
    auth: {
      endpoint,
      accessKey,
      secretKey,
      bucket,
      region: "auto",
    },
    key,
    body,
    contentType,
    cacheControl,
  });
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
  return await listR2ObjectKeys({
    auth: {
      endpoint,
      accessKey,
      secretKey,
      bucket,
      region: "auto",
    },
    prefix,
  });
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
  await deleteR2Object({
    auth: {
      endpoint,
      accessKey,
      secretKey,
      bucket,
      region: "auto",
    },
    key,
    acceptMissing: true,
  });
}

export async function deleteObjects({
  endpoint,
  accessKey,
  secretKey,
  bucket,
  keys,
  concurrency = 32,
  onDeleted,
}: {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  keys: string[];
  concurrency?: number;
  onDeleted?: (key: string) => void | Promise<void>;
}): Promise<void> {
  await deleteR2ObjectsConcurrently({
    auth: {
      endpoint,
      accessKey,
      secretKey,
      bucket,
      region: "auto",
    },
    keys,
    concurrency,
    acceptMissing: true,
    onDeleted,
  });
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
      s3Buckets = await listR2BucketsViaS3({
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
