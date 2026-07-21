import getLogger from "@cocalc/backend/logger";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  deriveProjectHostHostname,
  normalizeCloudflareHostname,
} from "@cocalc/server/cloud/derived-domains";
import { resolvePublicViewerDns } from "@cocalc/util/public-viewer-origin";

// Default TTL is ignored by Cloudflare when proxied.
const TTL = 120;

const logger = getLogger("server:cloud:dns");

async function getConfig(): Promise<{
  token?: string;
  dns?: string;
  settings: Record<string, any>;
}> {
  const {
    dns,
    project_hosts_cloudflare_tunnel_api_token: token,
    ...settings
  } = await getServerSettings();
  return {
    token,
    dns: normalizeCloudflareHostname(dns),
    settings: { ...settings, dns },
  };
}

export async function hasDns(): Promise<boolean> {
  const { token, dns } = await getConfig();
  return !!token && !!dns;
}

const zoneIdCache = new Map<string, string>();
type ZoneResponse = {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: Array<{ name?: string; id?: string }>;
};

type CloudflareResponse<T> = {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
};

type DnsRecord = {
  id?: string;
  name?: string;
  content?: string;
  type?: string;
};

export type CloudflareZoneSslMode = {
  value?: string;
  editable?: boolean;
  modified_on?: string;
};

export type CloudflareProjectHostSslRule = {
  ruleset_id: string;
  rule_id: string;
  ref: string;
  expression: string;
  ssl: "full";
};

type CloudflareConfigurationRule = {
  id?: string;
  ref?: string;
  description?: string;
  expression?: string;
  action?: string;
  action_parameters?: { ssl?: string };
  enabled?: boolean;
};

type CloudflareConfigurationRuleset = {
  id?: string;
  kind?: string;
  phase?: string;
  rules?: CloudflareConfigurationRule[];
};

// This identity intentionally differs from the deployment-scoped v1 rule.
// During a rolling upgrade, an old hub may continue rewriting v1 without
// affecting this deployment-independent safety rule.
const PROJECT_HOST_SSL_RULE_REF = "cocalc_project_host_direct_tls_v2";
const PROJECT_HOST_SSL_RULE_DESCRIPTION =
  "CoCalc project-host direct ingress uses zone-wide encrypted origin traffic";

const CNAME_CONFLICT_RECORD_TYPES = new Set(["A", "AAAA"]);
const ADDRESS_ROUTE_RECORD_TYPES = new Set(["A", "AAAA", "CNAME"]);

async function cloudflareRequest<T>(
  token: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
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
  let data: CloudflareResponse<T> | undefined;
  try {
    data = (await response.json()) as CloudflareResponse<T>;
  } catch {
    data = undefined;
  }
  if (!response.ok || !data?.success) {
    const details =
      data?.errors
        ?.map((err) =>
          [err.code != null ? `code=${err.code}` : undefined, err.message]
            .filter(Boolean)
            .join(" "),
        )
        .filter(Boolean)
        .join(", ") || "no Cloudflare error details";
    const statusText = response.statusText ? ` ${response.statusText}` : "";
    const permissionHint =
      response.status === 403 && path.includes("/rulesets")
        ? "; token requires Select Configuration Write for this zone"
        : "";
    throw new Error(
      `cloudflare api ${method} /${path} failed: HTTP ${response.status}${statusText}: ${details}${permissionHint}`,
    );
  }
  if (data.result === undefined) {
    throw new Error("cloudflare api returned no result");
  }
  return data.result;
}

function isNotFoundError(err: unknown): boolean {
  const message = String((err as Error)?.message ?? err).toLowerCase();
  return (
    message.includes("not found") ||
    message.includes("404") ||
    message.includes("does not exist")
  );
}

async function getZoneId(token: string, dns: string) {
  const cached = zoneIdCache.get(dns);
  if (cached) return cached;
  const url = new URL("https://api.cloudflare.com/client/v4/zones");
  url.searchParams.set("name", dns);
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(
      `cloudflare zones lookup failed: ${response.status} ${response.statusText}`,
    );
  }
  const data = (await response.json()) as ZoneResponse;
  if (!data?.success) {
    const details =
      data?.errors
        ?.map((err) => err.message)
        .filter(Boolean)
        .join(", ") || "unknown error";
    throw new Error(`cloudflare zones lookup failed: ${details}`);
  }
  const match = data.result?.find((zone) => zone.name === dns);
  if (match?.id) {
    zoneIdCache.set(dns, match.id);
    return match.id;
  }
  throw new Error(`cloudflare zone not found for ${dns}`);
}

async function getZoneForHostname(
  token: string,
  hostname: string,
): Promise<{ zoneId: string; zoneHostname: string }> {
  const parts = `${hostname ?? ""}`.split(".").filter(Boolean);
  for (let i = 0; i < parts.length - 1; i += 1) {
    const candidate = parts.slice(i).join(".");
    try {
      return {
        zoneId: await getZoneId(token, candidate),
        zoneHostname: candidate,
      };
    } catch (err) {
      if (!isNotFoundError(err)) {
        throw err;
      }
    }
  }
  throw new Error(`cloudflare zone not found for ${hostname}`);
}

async function getZoneIdForHostname(
  token: string,
  hostname: string,
): Promise<string> {
  return (await getZoneForHostname(token, hostname)).zoneId;
}

async function listDnsRecords(
  token: string,
  zoneId: string,
  name: string,
  type = "A",
): Promise<DnsRecord[]> {
  const qs = new URLSearchParams({ type, name });
  return await cloudflareRequest<DnsRecord[]>(
    token,
    "GET",
    `zones/${zoneId}/dns_records?${qs.toString()}`,
  );
}

async function listDnsRecordsByName(
  token: string,
  zoneId: string,
  name: string,
): Promise<DnsRecord[]> {
  const qs = new URLSearchParams({ name });
  return await cloudflareRequest<DnsRecord[]>(
    token,
    "GET",
    `zones/${zoneId}/dns_records?${qs.toString()}`,
  );
}

async function deleteAddressRecordsConflictingWithCname(opts: {
  token: string;
  zoneId: string;
  hostname: string;
  keepRecordId?: string;
}): Promise<void> {
  const records = await listDnsRecordsByName(
    opts.token,
    opts.zoneId,
    opts.hostname,
  );
  for (const record of records) {
    if (!record.id) continue;
    if (record.id === opts.keepRecordId) continue;
    const type = `${record.type ?? ""}`.trim().toUpperCase();
    if (!CNAME_CONFLICT_RECORD_TYPES.has(type)) continue;
    try {
      await cloudflareRequest(
        opts.token,
        "DELETE",
        `zones/${opts.zoneId}/dns_records/${record.id}`,
      );
    } catch (err) {
      if (!isNotFoundError(err)) {
        throw err;
      }
    }
  }
}

async function getClient(): Promise<{
  token: string;
  dns: string;
  settings: Record<string, any>;
}> {
  const { token, dns, settings } = await getConfig();
  if (!dns || !token) {
    throw new Error("cloudflare DNS not configured");
  }
  return { token, dns, settings };
}

async function getZoneClientForHostname(hostname: string): Promise<{
  token: string;
  zoneId: string;
  zoneHostname: string;
}> {
  const { token } = await getClient();
  const { zoneId, zoneHostname } = await getZoneForHostname(token, hostname);
  return { token, zoneId, zoneHostname };
}

export async function ensureHostDns(opts: {
  host_id: string;
  ipAddress: string;
  record_id?: string;
}): Promise<{ name: string; record_id: string }> {
  if (!opts.host_id) throw new Error("host_id required for DNS");
  if (!opts.ipAddress) throw new Error("ipAddress required for DNS");

  const { settings } = await getClient();
  const name = deriveProjectHostHostname(opts.host_id, settings);
  if (!name) throw new Error("cloudflare DNS not configured");
  return await ensureProxiedAddressDns({
    name,
    ipAddress: opts.ipAddress,
    record_id: opts.record_id,
  });
}

export async function ensureProxiedAddressDns(opts: {
  name: string;
  ipAddress: string;
  record_id?: string;
}): Promise<{ name: string; record_id: string }> {
  const name = `${opts.name ?? ""}`.trim().toLowerCase();
  if (!name) throw new Error("hostname required for DNS");
  if (!opts.ipAddress) throw new Error("ipAddress required for DNS");

  const { token } = await getClient();
  const zoneId = await getZoneIdForHostname(token, name);

  const updateRecord = async (record_id: string) => {
    const newData = {
      type: "A",
      content: opts.ipAddress,
      name,
      ttl: TTL,
      proxied: true,
    } as const;
    await cloudflareRequest(
      token,
      "PUT",
      `zones/${zoneId}/dns_records/${record_id}`,
      newData,
    );
  };

  const createRecord = async () => {
    const record = {
      type: "A",
      name,
      content: opts.ipAddress,
      ttl: TTL,
      proxied: true,
    } as const;
    const response = await cloudflareRequest<{ id?: string }>(
      token,
      "POST",
      `zones/${zoneId}/dns_records`,
      record,
    );
    const record_id = response?.id;
    if (!record_id) {
      throw new Error("cloudflare did not return record id");
    }
    logger.debug("dns record created", { name, record_id });
    return record_id;
  };

  let records = await listDnsRecordsByName(token, zoneId, name);
  let routeRecords = records.filter((record) =>
    ADDRESS_ROUTE_RECORD_TYPES.has(`${record.type ?? ""}`.toUpperCase()),
  );
  let recordIds = routeRecords
    .map((record) => record.id)
    .filter((id): id is string => !!id);
  let record_id = opts.record_id;

  if (record_id) {
    try {
      await updateRecord(record_id);
    } catch (err) {
      if (isNotFoundError(err)) {
        record_id = undefined;
      } else {
        throw err;
      }
    }
  }

  if (!record_id) {
    if (!recordIds.length) {
      record_id = await createRecord();
      records = [];
      routeRecords = [];
      recordIds = [];
    } else {
      record_id = recordIds[0];
      await updateRecord(record_id);
    }
  }

  if (recordIds.length > 1) {
    const extras = recordIds.filter((id) => id !== record_id);
    for (const id of extras) {
      try {
        await cloudflareRequest(
          token,
          "DELETE",
          `zones/${zoneId}/dns_records/${id}`,
        );
      } catch (err) {
        if (!isNotFoundError(err)) {
          throw err;
        }
      }
    }
  }

  return { name, record_id };
}

export async function getCloudflareIpv4Cidrs(): Promise<string[]> {
  const response = await fetch("https://api.cloudflare.com/client/v4/ips", {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(
      `cloudflare IP range lookup failed: ${response.status} ${response.statusText}`,
    );
  }
  const data = (await response.json()) as CloudflareResponse<{
    ipv4_cidrs?: string[];
  }>;
  if (!data?.success) {
    throw new Error("cloudflare IP range lookup failed");
  }
  const cidrs = Array.from(
    new Set(
      (data.result?.ipv4_cidrs ?? [])
        .map((cidr) => `${cidr ?? ""}`.trim())
        .filter(Boolean),
    ),
  ).sort();
  if (cidrs.length === 0) {
    throw new Error("cloudflare returned no IPv4 ranges");
  }
  return cidrs;
}

export async function getCloudflareZoneSslMode(
  hostname: string,
): Promise<CloudflareZoneSslMode> {
  const { token, zoneId } = await getZoneClientForHostname(hostname);
  const setting = await cloudflareRequest<{
    value?: string;
    editable?: boolean;
    modified_on?: string;
  }>(token, "GET", `zones/${zoneId}/settings/ssl`);
  return {
    value: `${setting?.value ?? ""}` || undefined,
    editable: setting?.editable == null ? undefined : Boolean(setting.editable),
    modified_on: `${setting?.modified_on ?? ""}` || undefined,
  };
}

export function projectHostSslRuleExpression(opts: {
  hostname: string;
  hostId: string;
  zoneHostname?: string;
}): string {
  const hostname = `${opts.hostname ?? ""}`.trim().toLowerCase();
  const hostId = `${opts.hostId ?? ""}`.trim().toLowerCase();
  const labels = hostname.split(".").filter(Boolean);
  const idOffset = labels[0]?.indexOf(hostId) ?? -1;
  const zoneHostname =
    normalizeCloudflareHostname(opts.zoneHostname) ?? labels.slice(1).join(".");
  if (
    !hostname ||
    !hostId ||
    idOffset <= 0 ||
    !zoneHostname ||
    !hostname.endsWith(`.${zoneHostname}`)
  ) {
    throw new Error(
      "cannot derive project-host Cloudflare SSL rule expression",
    );
  }
  const stablePrefix = labels[0].slice(0, idOffset);
  const zoneSuffix = `.${zoneHostname}`;
  return [
    "(",
    `(starts_with(http.host, ${JSON.stringify(stablePrefix)}) and ends_with(http.host, ${JSON.stringify(zoneSuffix)}))`,
    " or ",
    `(starts_with(http.host, "direct-check-") and ends_with(http.host, ${JSON.stringify(zoneSuffix)}))`,
    ")",
  ].join("");
}

function configurationRuleMatches(
  rule: CloudflareConfigurationRule,
  expression: string,
): boolean {
  return (
    rule.ref === PROJECT_HOST_SSL_RULE_REF &&
    rule.description === PROJECT_HOST_SSL_RULE_DESCRIPTION &&
    rule.expression === expression &&
    rule.action === "set_config" &&
    rule.action_parameters?.ssl === "full" &&
    rule.enabled === true
  );
}

export async function ensureCloudflareProjectHostSslRule(opts: {
  hostname: string;
  host_id: string;
}): Promise<CloudflareProjectHostSslRule> {
  const { token, zoneId, zoneHostname } = await getZoneClientForHostname(
    opts.hostname,
  );
  const expression = projectHostSslRuleExpression({
    hostname: opts.hostname,
    hostId: opts.host_id,
    zoneHostname,
  });
  const rulePayload = {
    ref: PROJECT_HOST_SSL_RULE_REF,
    description: PROJECT_HOST_SSL_RULE_DESCRIPTION,
    expression,
    action: "set_config",
    action_parameters: { ssl: "full" },
    enabled: true,
  } as const;
  const rulesets = await cloudflareRequest<CloudflareConfigurationRuleset[]>(
    token,
    "GET",
    `zones/${zoneId}/rulesets`,
  );
  let ruleset = rulesets.find(
    (candidate) =>
      candidate.kind === "zone" && candidate.phase === "http_config_settings",
  );
  if (!ruleset?.id) {
    ruleset = await cloudflareRequest<CloudflareConfigurationRuleset>(
      token,
      "POST",
      `zones/${zoneId}/rulesets`,
      {
        name: "CoCalc project-host configuration",
        description:
          "Configuration overrides required by direct CoCalc project-host ingress",
        kind: "zone",
        phase: "http_config_settings",
        rules: [rulePayload],
      },
    );
  } else {
    ruleset = await cloudflareRequest<CloudflareConfigurationRuleset>(
      token,
      "GET",
      `zones/${zoneId}/rulesets/${ruleset.id}`,
    );
    const existingRule = ruleset.rules?.find(
      (rule) =>
        rule.ref === PROJECT_HOST_SSL_RULE_REF ||
        rule.description === PROJECT_HOST_SSL_RULE_DESCRIPTION,
    );
    if (
      existingRule?.id &&
      !configurationRuleMatches(existingRule, expression)
    ) {
      await cloudflareRequest<CloudflareConfigurationRule>(
        token,
        "PATCH",
        `zones/${zoneId}/rulesets/${ruleset.id}/rules/${existingRule.id}`,
        rulePayload,
      );
    } else if (!existingRule?.id) {
      await cloudflareRequest<CloudflareConfigurationRule>(
        token,
        "POST",
        `zones/${zoneId}/rulesets/${ruleset.id}/rules`,
        rulePayload,
      );
    }
  }
  if (!ruleset?.id) {
    throw new Error("cloudflare did not return configuration ruleset id");
  }
  const verified = await cloudflareRequest<CloudflareConfigurationRuleset>(
    token,
    "GET",
    `zones/${zoneId}/rulesets/${ruleset.id}`,
  );
  const verifiedRule = verified.rules?.find(
    (rule) =>
      rule.ref === PROJECT_HOST_SSL_RULE_REF ||
      rule.description === PROJECT_HOST_SSL_RULE_DESCRIPTION,
  );
  if (
    !verifiedRule?.id ||
    !configurationRuleMatches(verifiedRule, expression)
  ) {
    throw new Error("cloudflare project-host SSL rule verification failed");
  }
  return {
    ruleset_id: ruleset.id,
    rule_id: verifiedRule.id,
    ref: PROJECT_HOST_SSL_RULE_REF,
    expression,
    ssl: "full",
  };
}

export async function deleteHostDns(opts: {
  record_id?: string;
  name?: string;
}) {
  if (!opts.record_id) return;
  const { token, dns } = await getClient();
  const zoneId = await getZoneIdForHostname(token, opts.name ?? dns);
  try {
    await cloudflareRequest(
      token,
      "DELETE",
      `zones/${zoneId}/dns_records/${opts.record_id}`,
    );
  } catch (err: any) {
    if (isNotFoundError(err)) {
      return;
    }
    throw err;
  }
}

export async function ensureHostnameCnameDns(opts: {
  hostname: string;
  target_hostname: string;
  record_id?: string;
}): Promise<{ record_id: string }> {
  const hostname = `${opts.hostname ?? ""}`.trim().toLowerCase();
  const target = `${opts.target_hostname ?? ""}`.trim().toLowerCase();
  if (!hostname) throw new Error("hostname required for app DNS");
  if (!target) throw new Error("target_hostname required for app DNS");

  const { token, zoneId } = await getZoneClientForHostname(hostname);
  const updateRecord = async (record_id: string) => {
    const payload = {
      type: "CNAME",
      name: hostname,
      content: target,
      ttl: TTL,
      proxied: true,
    } as const;
    await cloudflareRequest(
      token,
      "PUT",
      `zones/${zoneId}/dns_records/${record_id}`,
      payload,
    );
  };
  const createRecord = async (): Promise<string> => {
    const payload = {
      type: "CNAME",
      name: hostname,
      content: target,
      ttl: TTL,
      proxied: true,
    } as const;
    const response = await cloudflareRequest<{ id?: string }>(
      token,
      "POST",
      `zones/${zoneId}/dns_records`,
      payload,
    );
    const record_id = response?.id;
    if (!record_id) {
      throw new Error("cloudflare did not return app dns record id");
    }
    logger.debug("app dns record created", { hostname, target, record_id });
    return record_id;
  };

  let records = await listDnsRecords(token, zoneId, hostname, "CNAME");
  const recordIds = records
    .map((record) => record.id)
    .filter((id): id is string => !!id);
  let record_id = opts.record_id;
  if (record_id) {
    try {
      await updateRecord(record_id);
    } catch (err) {
      if (isNotFoundError(err)) {
        record_id = undefined;
      } else {
        throw err;
      }
    }
  }
  if (!record_id) {
    if (!recordIds.length) {
      await deleteAddressRecordsConflictingWithCname({
        token,
        zoneId,
        hostname,
      });
      record_id = await createRecord();
      records = [];
    } else {
      record_id = recordIds[0];
      await updateRecord(record_id);
    }
  }
  if (records.length > 1) {
    for (const record of records) {
      const id = record.id;
      if (!id || id === record_id) continue;
      try {
        await cloudflareRequest(
          token,
          "DELETE",
          `zones/${zoneId}/dns_records/${id}`,
        );
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
      }
    }
  }
  await deleteAddressRecordsConflictingWithCname({
    token,
    zoneId,
    hostname,
    keepRecordId: record_id,
  });
  return { record_id: record_id! };
}

export async function ensureAppSubdomainDns(opts: {
  hostname: string;
  target_hostname: string;
  record_id?: string;
}): Promise<{ record_id: string }> {
  return await ensureHostnameCnameDns(opts);
}

export async function ensurePublicViewerDns(): Promise<
  { hostname: string; target_hostname: string; record_id: string } | undefined
> {
  const settings = await getServerSettings();
  const hostname = normalizeCloudflareHostname(
    resolvePublicViewerDns({
      publicViewerDns: settings.public_viewer_dns as string | undefined,
      dns: settings.dns as string | undefined,
    }) ?? "",
  );
  let target_hostname = normalizeCloudflareHostname(settings.dns);
  if (!hostname || !target_hostname || hostname === target_hostname) {
    return undefined;
  }
  // If the main site hostname is itself fronted by a Cloudflare tunnel, point the
  // dedicated public-viewer hostname directly at the tunnel target instead of at
  // the main hostname. That matches how Cloudflare normally models tunnel-backed
  // hostnames and avoids creating a proxied CNAME that just points at another
  // proxied hostname.
  const tunnelTarget = await getCnameTargetForHostname(target_hostname);
  if (tunnelTarget?.endsWith(".cfargotunnel.com")) {
    target_hostname = tunnelTarget;
  }
  const { record_id } = await ensureAppSubdomainDns({
    hostname,
    target_hostname,
  });
  return { hostname, target_hostname, record_id };
}

export async function getCnameTargetForHostname(
  hostname: string,
): Promise<string | undefined> {
  const name = `${hostname ?? ""}`.trim().toLowerCase();
  if (!name) return;
  const { token } = await getConfig();
  if (!token) {
    throw new Error("cloudflare DNS not configured");
  }
  const zoneId = await getZoneIdForHostname(token, name);
  const records = await listDnsRecords(token, zoneId, name, "CNAME");
  const record = records.find(
    (entry) => `${entry.name ?? ""}`.trim().toLowerCase() === name,
  );
  const target = `${record?.content ?? ""}`.trim().toLowerCase();
  return target || undefined;
}

export async function deleteAppSubdomainDns(opts: {
  record_id?: string;
  hostname?: string;
}): Promise<void> {
  if (!opts.record_id) return;
  const { token, dns } = await getClient();
  const zoneId = await getZoneIdForHostname(token, opts.hostname ?? dns);
  try {
    await cloudflareRequest(
      token,
      "DELETE",
      `zones/${zoneId}/dns_records/${opts.record_id}`,
    );
  } catch (err) {
    if (isNotFoundError(err)) return;
    throw err;
  }
}
