/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

type CloudflareResponse<T> = {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
};

type CloudflareCapability = {
  ok: boolean;
  message?: string;
};

export type CloudflareBootstrapResult = {
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
  const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  let payload: CloudflareResponse<T> | undefined;
  try {
    payload = (await response.json()) as CloudflareResponse<T>;
  } catch {
    payload = undefined;
  }
  if (!response.ok || !payload?.success) {
    // Do not propagate provider messages: they may echo request secrets.
    throw new Error(
      `Cloudflare ${method} ${path.split("?")[0]} failed (HTTP ${response.status}). Check the token permissions and expiry.`,
    );
  }
  return payload.result as T;
}

async function verifyToken(token: string): Promise<TokenVerifyResult> {
  const verified = await cloudflareRequest<TokenVerifyResult>(
    token,
    "GET",
    "user/tokens/verify",
  );
  if (verified.status && verified.status !== "active") {
    throw new Error(`Cloudflare token is ${verified.status}`);
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
    throw new Error(
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
    permissions: [],
    values: {},
    notes,
    tunnel_token: { ok: false },
    visitor_location_headers: { ok: false },
    r2: {
      ok: false,
      message:
        "Save separate R2 S3 credentials, then provision and test image delivery.",
    },
  };
  let discovery: CreatedToken | undefined;
  let durable: CreatedToken | undefined;
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
    stage = "create a temporary zone discovery token";
    const zoneRead = requirePermissionGroup(
      groups,
      ["Zone Read"],
      "com.cloudflare.api.account.zone",
    );
    discovery = await cloudflareRequest<CreatedToken>(
      token,
      "POST",
      "user/tokens",
      {
        name: "CoCalc temporary zone discovery",
        expires_on: new Date(Date.now() + 10 * 60_000).toISOString(),
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
    const values: Record<string, string> = {
      cloudflare_mode: "self",
      project_hosts_cloudflare_tunnel_enabled: "yes",
      project_hosts_cloudflare_tunnel_account_id: accountId,
      r2_account_id: accountId,
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
      ...(opts.r2BucketPrefix ? { r2_bucket_prefix: opts.r2BucketPrefix } : {}),
    };
    stage = "save the automation token";
    saveAttempted = true;
    await opts.save({
      ...values,
      project_hosts_cloudflare_tunnel_api_token: durable.value,
      r2_api_token: durable.value,
    });
    saved = true;
    result.values = values;
    result.tunnel_token = {
      ok: true,
      message: "Scoped automation token saved on the server.",
    };
  } catch {
    // Neither provider nor database exceptions are safe to expose here.
    result.tunnel_token = {
      ok: false,
      message: `Unable to ${stage}. Check permissions, domain and expiry; retry with a new bootstrap token.`,
    };
    if (saveAttempted && durable?.id) {
      notes.push(
        `Saving may have partially completed. Check stored settings before deleting automation token ${durable.id}; it has not been revoked.`,
      );
    }
  } finally {
    for (const child of [discovery, ...(!saveAttempted ? [durable] : [])]) {
      if (!child?.id) continue;
      const cleanup = await invalidateBootstrapToken({
        token,
        tokenId: child.id,
      });
      if (!cleanup.invalidated)
        notes.push(
          `Delete temporary or unsaved Cloudflare token ${child.id} manually in API Tokens.`,
        );
    }
    const cleanup = await invalidateBootstrapToken({
      token,
      tokenId: result.bootstrap_token_id,
    });
    result.bootstrap_token_invalidated = cleanup.invalidated;
    if (!cleanup.invalidated) {
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
