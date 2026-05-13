/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

type CloudflareResponse<T> = {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: T;
};

type CloudflareCapability = {
  ok: boolean;
  message?: string;
};

export type CloudflareBootstrapResult = {
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
  });
  let payload: CloudflareResponse<T> | undefined;
  try {
    payload = (await response.json()) as CloudflareResponse<T>;
  } catch {
    payload = undefined;
  }
  if (!response.ok || !payload?.success) {
    const details =
      payload?.errors
        ?.map((err) => err.message)
        .filter(Boolean)
        .join(", ") ||
      `${response.status} ${response.statusText}`.trim() ||
      "unknown error";
    throw new Error(`cloudflare api failed: ${details}`);
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
  const wanted = names.map((name) => name.toLowerCase());
  return groups.find((group) => {
    const name = group.name?.toLowerCase();
    if (!name || !wanted.includes(name)) return false;
    return group.scopes?.includes(scope);
  });
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

async function createDurableTunnelToken(opts: {
  bootstrapToken: string;
  accountId: string;
  zoneId: string;
  zoneName: string;
}): Promise<CreatedToken> {
  const groups = await cloudflareRequest<PermissionGroup[]>(
    opts.bootstrapToken,
    "GET",
    "user/tokens/permission_groups",
  );
  const accountScope = "com.cloudflare.api.account";
  const zoneScope = "com.cloudflare.api.account.zone";
  const accountGroups = [
    requirePermissionGroup(
      groups,
      ["Cloudflare Tunnel Write", "Cloudflare Tunnel Edit"],
      accountScope,
    ),
  ];
  const zoneGroups = [
    requirePermissionGroup(groups, ["Zone Read"], zoneScope),
    requirePermissionGroup(groups, ["DNS Write", "DNS Edit"], zoneScope),
    requirePermissionGroup(
      groups,
      ["Managed headers Write", "Managed Headers Write"],
      zoneScope,
    ),
  ];
  const r2Group = findPermissionGroup(
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
      name: `CoCalc Launchpad ${opts.zoneName}`,
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
  return { ...created, r2Included: !!r2Group?.id };
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
  invalidateBootstrapToken?: boolean;
}): Promise<CloudflareBootstrapResult> {
  const token = clean(opts.token);
  if (!token) throw new Error("Cloudflare bootstrap token is required");
  const domain = normalizeHostname(opts.domain);
  if (!domain) throw new Error("Cloudflare external domain is required");

  const notes: string[] = [];
  const verified = await verifyToken(token);
  const zone = await lookupZone(token, domain);
  const zoneId = zone.id;
  const zoneName = zone.name;
  const accountId = zone.account?.id;
  if (!zoneId || !zoneName || !accountId) {
    throw new Error("Cloudflare zone lookup did not return account metadata");
  }

  let durable: CreatedToken | undefined;
  let tunnelToken: CloudflareCapability = {
    ok: false,
    message: "Durable token was not created.",
  };
  try {
    durable = await createDurableTunnelToken({
      bootstrapToken: token,
      accountId,
      zoneId,
      zoneName,
    });
    if (durable.value) {
      tunnelToken = {
        ok: true,
        message: "Created a durable Cloudflare token for CoCalc.",
      };
    } else {
      tunnelToken = {
        ok: false,
        message: "Cloudflare created a token but did not return its secret.",
      };
    }
  } catch (err) {
    tunnelToken = {
      ok: false,
      message: `${err}`,
    };
    notes.push(
      "Could not create a narrower durable token automatically. Leave the bootstrap token active until you create/paste a Cloudflare API token manually.",
    );
  }

  let visitorLocationHeaders: CloudflareBootstrapResult["visitor_location_headers"];
  try {
    visitorLocationHeaders = await enableVisitorLocationHeaders({
      token,
      zoneId,
    });
  } catch (err) {
    visitorLocationHeaders = {
      ok: false,
      message: `${err}`,
    };
  }

  let invalidation: { invalidated: boolean; error?: string } | undefined =
    undefined;
  if (opts.invalidateBootstrapToken !== false && durable?.value) {
    invalidation = await invalidateBootstrapToken({
      token,
      tokenId: verified.id,
    });
    if (!invalidation.invalidated) {
      notes.push(
        "Cloudflare bootstrap token could not be invalidated automatically; delete it manually or rely on its TTL.",
      );
    }
  }

  const values: Record<string, string> = {
    cloudflare_mode: "self",
    project_hosts_cloudflare_tunnel_enabled: "yes",
    project_hosts_cloudflare_tunnel_account_id: accountId,
    dns: domain,
    r2_account_id: accountId,
  };
  if (durable?.value) {
    values.project_hosts_cloudflare_tunnel_api_token = durable.value;
    if (durable.r2Included) {
      values.r2_api_token = durable.value;
    }
  }
  if (opts.tunnelPrefix) {
    values.project_hosts_cloudflare_tunnel_prefix = opts.tunnelPrefix;
  }
  if (opts.hostSuffix) {
    values.project_hosts_cloudflare_tunnel_host_suffix = opts.hostSuffix;
  }
  if (opts.r2BucketPrefix) {
    values.r2_bucket_prefix = opts.r2BucketPrefix;
  }

  return {
    account_id: accountId,
    account_name: zone.account?.name,
    zone_id: zoneId,
    zone_name: zoneName,
    durable_token_id: durable?.id,
    bootstrap_token_id: verified.id,
    bootstrap_token_invalidated: invalidation?.invalidated,
    bootstrap_token_invalidation_error: invalidation?.error,
    tunnel_token: tunnelToken,
    visitor_location_headers: visitorLocationHeaders,
    r2:
      durable?.value && durable.r2Included
        ? {
            ok: false,
            message:
              "R2 API token was filled from the durable Cloudflare token, but R2 S3 access key ID and secret still need to be created/pasted.",
          }
        : {
            ok: false,
            message: "R2 credentials still need to be created/pasted manually.",
          },
    values,
    notes,
  };
}
