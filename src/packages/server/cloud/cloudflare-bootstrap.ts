/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import getLogger from "@cocalc/backend/logger";
import { R2_REGIONS } from "@cocalc/util/consts/r2-regions";

const logger = getLogger("server:cloud:cloudflare-bootstrap");

// Only local or explicitly sanitized diagnostics may cross the RPC boundary.
class BootstrapDiagnostic extends Error {}

type CloudflareResponse<T> = {
  success?: boolean;
  errors?: unknown;
  result?: T;
};

type CloudflareCapability = {
  ok: boolean;
  message?: string;
};

export type CloudflareBootstrapResult = {
  cleanup_required?: boolean;
  failure?: string;
  settings_status?: "not_saved" | "saved" | "unknown";
  permissions: string[];
  account_id?: string;
  account_name?: string;
  zone_id?: string;
  zone_name?: string;
  durable_token_id?: string;
  bootstrap_token_id?: string;
  bootstrap_token_invalidated?: boolean;
  bootstrap_token_invalidation_error?: string;
  tunnel_token: CloudflareCapability;
  visitor_location_headers: CloudflareCapability & { transform_id?: string };
  r2: CloudflareCapability;
  values: Record<string, string>;
  notes: string[];
};

type Zone = {
  id?: string;
  name?: string;
  account?: { id?: string; name?: string };
};

type TokenVerifyResult = {
  id?: string;
  status?: string;
  expires_on?: string;
  not_before?: string;
};

type PermissionGroup = {
  id?: string;
  name?: string;
  scopes?: string[];
};

type CreatedToken = {
  id?: string;
  value?: string;
  r2Included?: boolean;
  permissions?: string[];
};

type ManagedTransform = {
  id?: string;
  enabled?: boolean;
  has_conflict?: boolean;
};

type ManagedTransformList = {
  managed_request_headers?: ManagedTransform[];
  managed_response_headers?: ManagedTransform[];
};

function clean(value: unknown): string | undefined {
  if (value == null) return undefined;
  const trimmed = `${value}`.trim();
  return trimmed || undefined;
}

function normalizeHostname(value: string): string {
  let host = value.trim().toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("http://") || host.startsWith("https://")) {
    host = new URL(host).hostname;
  }
  return host.split("/")[0].split(":")[0].replace(/\.+$/, "");
}

function inferZoneCandidates(hostname: string): string[] {
  const parts = hostname.split(".").filter(Boolean);
  const candidates: string[] = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    candidates.push(parts.slice(i).join("."));
  }
  return candidates;
}

async function cloudflareRequest<T>(
  token: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: Record<string, any>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new BootstrapDiagnostic(
      "Cloudflare could not be reached or the request timed out. Check hub network connectivity and retry.",
    );
  }
  let payload: CloudflareResponse<T> | undefined;
  try {
    payload = (await response.json()) as CloudflareResponse<T>;
  } catch {
    payload = undefined;
  }
  if (!response.ok || !payload?.success) {
    const detail = cloudflareErrorDetail(payload?.errors, token);
    throw new BootstrapDiagnostic(
      `Cloudflare rejected ${method} ${method === "DELETE" ? "user/tokens/[id]" : path.split("?")[0]} (HTTP ${response.status}).${detail ? ` ${detail}` : " No usable validation details were returned."}`,
    );
  }
  return payload.result as T;
}

// Project only bounded validation messages and numeric codes, never the response
// body, request headers, result.value, or arbitrary exception text. A message
// echoing the bearer credential is omitted entirely, not merely truncated.
function cloudflareErrorDetail(errors: unknown, token: string): string {
  const variants = [
    token,
    encodeURIComponent(token),
    [...Buffer.from(token)]
      .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
      .join(""),
    Buffer.from(token).toString("base64"),
    Buffer.from(token).toString("base64url"),
    Buffer.from(token).toString("hex"),
    [...token]
      .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join(""),
  ]
    .filter(Boolean)
    .map((value) => value.toLowerCase());
  const details: string[] = [];
  function visit(value: unknown, depth: number) {
    if (!Array.isArray(value) || depth > 3) return;
    for (const error of value.slice(0, 5)) {
      if (details.length >= 8) return;
      if (error == null || typeof error !== "object") continue;
      const code = Number.isSafeInteger(error.code)
        ? `Code ${error.code}: `
        : "";
      let message = "";
      if (typeof error.message === "string") {
        if (error.message.length > 4096) {
          message = "[oversized provider message omitted]";
        } else {
          message = error.message.replace(
            /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g,
            "",
          );
          if (
            variants.some((secret) => message.toLowerCase().includes(secret))
          ) {
            message = "[credential-bearing provider message omitted]";
          } else {
            message = message
              .replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [redacted]")
              .replace(/[a-zA-Z0-9_+\/%=-]{32,}/g, "[redacted]")
              .slice(0, 512);
          }
        }
      }
      if (code || message) details.push(`${code}${message}`);
      visit(error.error_chain, depth + 1);
    }
  }
  visit(errors, 0);
  return details.join("; ").slice(0, 2048);
}

async function verifyToken(token: string): Promise<TokenVerifyResult> {
  const verified = await cloudflareRequest<TokenVerifyResult>(
    token,
    "GET",
    "user/tokens/verify",
  );
  if (
    verified?.status === "expired" ||
    (verified?.expires_on && Date.parse(verified.expires_on) <= Date.now())
  ) {
    throw new BootstrapDiagnostic(
      "The bootstrap token has expired. Cloudflare dates start at 00:00 UTC; create a new token with a future End Date.",
    );
  }
  if (verified?.status === "disabled") {
    throw new BootstrapDiagnostic(
      "The bootstrap token is disabled. Create a new active token.",
    );
  }
  if (verified?.not_before && Date.parse(verified.not_before) > Date.now()) {
    throw new BootstrapDiagnostic(
      "The bootstrap token is not valid yet. Leave Start Date unset when creating its replacement.",
    );
  }
  if (verified?.status !== "active") {
    throw new BootstrapDiagnostic(
      "Cloudflare did not confirm an active bootstrap token. Create a new user API token using the provided link.",
    );
  }
  return verified;
}

async function lookupZone(token: string, hostname: string): Promise<Zone> {
  for (const candidate of inferZoneCandidates(hostname)) {
    const qs = new URLSearchParams({ name: candidate });
    const zones = await cloudflareRequest<Zone[]>(
      token,
      "GET",
      `zones?${qs.toString()}`,
    );
    const match = zones.find((zone) => zone.name === candidate);
    if (match?.id && match.name) {
      return match;
    }
  }
  throw new Error(`Cloudflare zone not found for ${hostname}`);
}

function findPermissionGroup(
  groups: PermissionGroup[],
  names: string[],
  scope: string,
): PermissionGroup | undefined {
  for (const wanted of names) {
    const match = groups.find(
      (group) =>
        group.name?.toLowerCase() === wanted.toLowerCase() &&
        group.scopes?.includes(scope),
    );
    if (match) return match;
  }
  return undefined;
}

function requirePermissionGroup(
  groups: PermissionGroup[],
  names: string[],
  scope: string,
): PermissionGroup {
  const group = findPermissionGroup(groups, names, scope);
  if (!group?.id) {
    // Names and scope come from our fixed requirements, not provider messages.
    throw new BootstrapDiagnostic(
      `Cloudflare permission group not found: ${names.join(" or ")} (${scope})`,
    );
  }
  return group;
}

async function createDurableAutomationToken(opts: {
  bootstrapToken: string;
  accountId: string;
  zoneId: string;
  zoneName: string;
  siteDomain: string;
  groups: PermissionGroup[];
}): Promise<CreatedToken> {
  const groups = opts.groups;
  const accountScope = "com.cloudflare.api.account";
  const zoneScope = "com.cloudflare.api.account.zone";
  const accountGroups = [
    requirePermissionGroup(
      groups,
      ["Cloudflare Tunnel Write", "Cloudflare Tunnel Edit"],
      accountScope,
    ),
    requirePermissionGroup(
      groups,
      ["Workers Scripts Write", "Workers Scripts Edit"],
      accountScope,
    ),
  ];
  const zoneGroups = [
    requirePermissionGroup(groups, ["Zone Read"], zoneScope),
    requirePermissionGroup(groups, ["DNS Write", "DNS Edit"], zoneScope),
    requirePermissionGroup(
      groups,
      ["Workers Routes Write", "Workers Routes Edit"],
      zoneScope,
    ),
    requirePermissionGroup(
      groups,
      [
        "Config Settings Write",
        "Config Rules Write",
        "Config Rules Edit",
        "Select Configuration Write",
      ],
      zoneScope,
    ),
    requirePermissionGroup(
      groups,
      ["Managed headers Write", "Managed Headers Write"],
      zoneScope,
    ),
  ];
  const r2Group = requirePermissionGroup(
    groups,
    [
      "Workers R2 Storage Write",
      "Workers R2 Storage Edit",
      "R2 Storage Write",
      "R2 Storage Edit",
    ],
    accountScope,
  );
  if (r2Group?.id) {
    accountGroups.push(r2Group);
  }
  const analyticsGroup = findPermissionGroup(
    groups,
    ["Account Analytics Read", "Analytics Read"],
    accountScope,
  );
  if (analyticsGroup?.id) {
    accountGroups.push(analyticsGroup);
  }
  const created = await cloudflareRequest<CreatedToken>(
    opts.bootstrapToken,
    "POST",
    "user/tokens",
    {
      name: `CoCalc automation ${opts.siteDomain}`,
      policies: [
        {
          effect: "allow",
          resources: {
            [`com.cloudflare.api.account.${opts.accountId}`]: "*",
          },
          permission_groups: accountGroups.map((group) => ({ id: group.id })),
        },
        {
          effect: "allow",
          resources: {
            [`com.cloudflare.api.account.zone.${opts.zoneId}`]: "*",
          },
          permission_groups: zoneGroups.map((group) => ({ id: group.id })),
        },
      ],
    },
  );
  return {
    ...created,
    r2Included: true,
    permissions: [...accountGroups, ...zoneGroups].map((group) => group.name!),
  };
}

function findVisitorLocationTransform(
  transforms: ManagedTransform[],
): ManagedTransform | undefined {
  return transforms.find((transform) => {
    const id = transform.id?.toLowerCase() ?? "";
    return (
      id === "add_visitor_location_headers" ||
      (id.includes("visitor") && id.includes("location"))
    );
  });
}

async function enableVisitorLocationHeaders(opts: {
  token: string;
  zoneId: string;
}): Promise<CloudflareBootstrapResult["visitor_location_headers"]> {
  const current = await cloudflareRequest<ManagedTransformList>(
    opts.token,
    "GET",
    `zones/${opts.zoneId}/managed_headers`,
  );
  const requestHeaders = current.managed_request_headers ?? [];
  const target = findVisitorLocationTransform(requestHeaders);
  if (!target?.id) {
    return {
      ok: false,
      message: "Add visitor location headers transform was not found.",
    };
  }
  if (target.has_conflict) {
    return {
      ok: false,
      transform_id: target.id,
      message: "Add visitor location headers conflicts with another transform.",
    };
  }
  if (!target.enabled) {
    await cloudflareRequest<ManagedTransformList>(
      opts.token,
      "PATCH",
      `zones/${opts.zoneId}/managed_headers`,
      {
        managed_request_headers: requestHeaders.map((header) => ({
          id: header.id,
          enabled: header.id === target.id ? true : !!header.enabled,
        })),
        managed_response_headers: current.managed_response_headers ?? [],
      },
    );
  }
  return {
    ok: true,
    transform_id: target.id,
    message: target.enabled
      ? "Visitor location headers were already enabled."
      : "Visitor location headers enabled.",
  };
}

async function invalidateBootstrapToken(opts: {
  token: string;
  tokenId?: string;
}): Promise<{ invalidated: boolean; error?: string }> {
  if (!opts.tokenId) {
    return {
      invalidated: false,
      error: "Cloudflare token id was not returned",
    };
  }
  try {
    await cloudflareRequest<{ id?: string }>(
      opts.token,
      "DELETE",
      `user/tokens/${opts.tokenId}`,
    );
    return { invalidated: true };
  } catch (err) {
    return { invalidated: false, error: `${err}` };
  }
}

export async function bootstrapCloudflareConfiguration(opts: {
  domain: string;
  token: string;
  tunnelPrefix?: string;
  hostSuffix?: string;
  r2BucketPrefix?: string;
  // Loaded only from seed-bay settings, never accepted from the RPC caller.
  existingR2?: {
    accountId?: string;
    accessKey?: string;
    secretKey?: string;
    bucketPrefix?: string;
    blobBucket?: string;
  };
  // Persistence stays server-side; no token secret is returned to the caller.
  save: (values: Record<string, string>) => Promise<void>;
}): Promise<CloudflareBootstrapResult> {
  const token = clean(opts.token);
  if (!token) throw new Error("Cloudflare bootstrap token is required");
  const domain = normalizeHostname(opts.domain);
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) {
    throw new Error("Enter a valid Cloudflare external domain.");
  }
  if (
    opts.r2BucketPrefix &&
    !/^[a-z0-9][a-z0-9-]{0,50}[a-z0-9]$/.test(opts.r2BucketPrefix)
  ) {
    throw new Error(
      "Use 2-52 lowercase letters, numbers or hyphens for the bucket prefix.",
    );
  }
  const notes: string[] = [];
  const result: CloudflareBootstrapResult = {
    settings_status: "not_saved",
    permissions: [],
    values: {},
    notes,
    tunnel_token: { ok: false },
    visitor_location_headers: { ok: false },
    r2: {
      ok: false,
      message: "R2 S3 credentials have not been saved.",
    },
  };
  let discovery: CreatedToken | undefined;
  let durable: CreatedToken | undefined;
  let s3: CreatedToken | undefined;
  let saved = false;
  let saveAttempted = false;
  let stage = "verify the bootstrap token";
  try {
    const verified = await verifyToken(token);
    result.bootstrap_token_id = verified.id;
    stage = "discover token permissions";
    const groups = await cloudflareRequest<PermissionGroup[]>(
      token,
      "GET",
      "user/tokens/permission_groups",
    );
    // The Create additional tokens template cannot list zones itself. Its
    // short-lived child has only Zone Read, and is always removed below.
    stage = "resolve the Zone Read permission";
    const zoneRead = requirePermissionGroup(
      groups,
      ["Zone Read"],
      "com.cloudflare.api.account.zone",
    );
    stage = "create a temporary zone discovery token";
    discovery = await cloudflareRequest<CreatedToken>(
      token,
      "POST",
      "user/tokens",
      {
        name: "CoCalc temporary zone discovery",
        // Cloudflare's token API rejects fractional seconds, including .000Z.
        expires_on: new Date(Date.now() + 10 * 60_000)
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z"),
        policies: [
          {
            effect: "allow",
            resources: { "com.cloudflare.api.account.zone.*": "*" },
            permission_groups: [{ id: zoneRead.id }],
          },
        ],
      },
    );
    if (!discovery.value) throw new Error("Missing discovery token secret");
    stage = "find the domain's Cloudflare zone";
    const zone = await lookupZone(discovery.value, domain);
    const zoneId = zone.id;
    const zoneName = zone.name;
    const accountId = zone.account?.id;
    if (!zoneId || !zoneName || !accountId)
      throw new Error("Missing zone metadata");
    Object.assign(result, {
      zone_id: zoneId,
      zone_name: zoneName,
      account_id: accountId,
      account_name: zone.account?.name,
    });
    stage = "validate existing R2 configuration";
    const existing = opts.existingR2;
    const accessKey = clean(existing?.accessKey);
    const secretKey = clean(existing?.secretKey);
    const prefix = clean(opts.r2BucketPrefix) ?? clean(existing?.bucketPrefix);
    if (!prefix) throw new Error("Missing R2 bucket prefix");
    if (accessKey || secretKey) {
      if (
        !accessKey ||
        !secretKey ||
        clean(existing?.accountId) !== accountId ||
        clean(existing?.bucketPrefix) !== prefix
      ) {
        notes.push(
          "Existing R2 credentials are incomplete or the account/bucket prefix changed. No settings were changed. An operator must review the underlying R2 site settings before retrying; bootstrap never replaces existing S3 credentials or moves backup data.",
        );
        throw new Error("Existing R2 configuration needs review");
      }
    }
    stage = "create the scoped automation token";
    durable = await createDurableAutomationToken({
      bootstrapToken: token,
      accountId,
      zoneId,
      zoneName,
      siteDomain: domain,
      groups,
    });
    result.durable_token_id = durable.id;
    result.permissions = durable.permissions ?? [];
    if (!durable.value) throw new Error("Missing automation token secret");
    if (!accessKey) {
      stage =
        "create the bucket-scoped R2 S3 token (enable R2 in Cloudflare first)";
      const objectWrite = requirePermissionGroup(
        groups,
        ["Workers R2 Storage Bucket Item Write"],
        "com.cloudflare.edge.r2.bucket",
      );
      const buckets = [
        ...R2_REGIONS.map((region) => `${prefix}-${region}`),
        clean(existing?.blobBucket) ?? `${prefix}-blobs`,
      ];
      if (
        buckets.some(
          (bucket) => !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket),
        )
      )
        throw new Error("Invalid R2 bucket name");
      s3 = await cloudflareRequest<CreatedToken>(token, "POST", "user/tokens", {
        name: `CoCalc R2 objects ${domain}`,
        policies: [
          {
            effect: "allow",
            resources: Object.fromEntries(
              buckets.map((bucket) => [
                `com.cloudflare.edge.r2.bucket.${accountId}_default_${bucket}`,
                "*",
              ]),
            ),
            permission_groups: [{ id: objectWrite.id }],
          },
        ],
      });
      if (!s3.id || !s3.value) throw new Error("Missing S3 token credentials");
    }
    const values: Record<string, string> = {
      cloudflare_mode: "self",
      project_hosts_cloudflare_tunnel_enabled: "yes",
      project_hosts_cloudflare_tunnel_account_id: accountId,
      r2_account_id: accountId,
      r2_access_key_id: accessKey ?? s3!.id!,
      cloudflare_automation_token_id: durable.id ?? "",
      cloudflare_zone_id: zoneId,
      cloudflare_zone_name: zoneName,
      dns: domain,
      ...(opts.tunnelPrefix
        ? { project_hosts_cloudflare_tunnel_prefix: opts.tunnelPrefix }
        : {}),
      ...(opts.hostSuffix
        ? { project_hosts_cloudflare_tunnel_host_suffix: opts.hostSuffix }
        : {}),
      r2_bucket_prefix: prefix,
    };
    stage = "save the automation token";
    saveAttempted = true;
    await opts.save({
      ...values,
      project_hosts_cloudflare_tunnel_api_token: durable.value,
      r2_api_token: durable.value,
      // Cloudflare documents id + SHA-256(value) as the S3 credential pair.
      // Keep this separate from the account-wide REST automation token.
      ...(s3?.value
        ? {
            r2_secret_access_key: createHash("sha256")
              .update(s3.value)
              .digest("hex"),
          }
        : {}),
    });
    saved = true;
    result.settings_status = "saved";
    result.values = values;
    result.tunnel_token = {
      ok: true,
      message: "Scoped automation token saved on the server.",
    };
    result.r2 = {
      ok: true,
      message: s3
        ? "Bucket-scoped R2 S3 credentials created and saved server-side. Provision blob storage and run R2 diagnostics to verify access."
        : "Existing R2 S3 credentials preserved. Run R2 diagnostics to verify access.",
    };
  } catch (err) {
    // Neither provider nor database exceptions are safe to expose here.
    result.settings_status = saveAttempted ? "unknown" : "not_saved";
    result.failure = `Unable to ${stage}. ${err instanceof BootstrapDiagnostic ? err.message : "Check permissions, domain and expiry; retry with a new bootstrap token."}`;
    logger.warn("bootstrap failed", {
      diagnostic: result.failure,
      settings_status: result.settings_status,
    });
    if (stage.startsWith("create the bucket-scoped R2 S3 token") && !s3) {
      notes.push(
        `If Cloudflare created an R2 token but its response was lost, inspect API Tokens for "CoCalc R2 objects ${domain}" before retrying; an unknown token ID cannot be revoked automatically.`,
      );
    }
    result.tunnel_token = {
      ok: false,
      message: result.failure,
    };
    if (saveAttempted && durable?.id) {
      notes.push(
        `Saving may have partially completed. Check stored settings before deleting automation token ${durable.id}; it has not been revoked.`,
      );
      if (s3?.id)
        notes.push(
          `R2 S3 token ${s3.id} may also have been saved and has not been revoked. Check stored settings before deleting it.`,
        );
    }
  } finally {
    for (const child of [discovery, ...(!saveAttempted ? [durable, s3] : [])]) {
      if (!child?.id) continue;
      const cleanup = await invalidateBootstrapToken({
        token,
        tokenId: child.id,
      });
      if (!cleanup.invalidated) {
        result.cleanup_required = true;
        notes.push(
          `Delete temporary or unsaved Cloudflare token ${child.id} manually in API Tokens.`,
        );
      }
    }
    const cleanup = await invalidateBootstrapToken({
      token,
      tokenId: result.bootstrap_token_id,
    });
    result.bootstrap_token_invalidated = cleanup.invalidated;
    if (!cleanup.invalidated) {
      result.cleanup_required = true;
      result.bootstrap_token_invalidation_error =
        "Delete the bootstrap token manually in Cloudflare API Tokens.";
      notes.push(result.bootstrap_token_invalidation_error);
    }
  }
  if (saved && durable?.value && result.zone_id) {
    try {
      result.visitor_location_headers = await enableVisitorLocationHeaders({
        token: durable.value,
        zoneId: result.zone_id,
      });
    } catch {
      result.visitor_location_headers = {
        ok: false,
        message:
          "Automation token saved; enabling visitor location headers failed. Retry configuration or enable them in Cloudflare.",
      };
    }
  }
  return result;
}
