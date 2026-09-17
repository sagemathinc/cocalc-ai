import getLogger from "@cocalc/backend/logger";
import crypto from "node:crypto";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getDerivedBayPublicHostname } from "@cocalc/server/bay-public-origin";
import {
  deriveProjectHostSuffix,
  normalizeCloudflareHostname,
} from "@cocalc/server/cloud/derived-domains";

const logger = getLogger("server:cloud:cloudflare-tunnel");
const TTL = 120;
const CLOUDFLARE_API_TIMEOUT_MS = 15_000;

export type CloudflareTunnel = {
  id: string;
  name: string;
  hostname: string;
  ssh_hostname?: string;
  tunnel_secret: string;
  account_id: string;
  record_id?: string;
  ssh_record_id?: string;
  token?: string;
};

type TunnelConfig = {
  accountId: string;
  token: string;
  dns: string;
  prefix?: string;
  hostSuffix?: string;
};

type HubTunnelConfig = {
  accountId: string;
  token: string;
  zone: string;
  hostname: string;
  prefix?: string;
};

type CloudflareResponse<T> = {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: T;
};

type ZoneResponse = {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: Array<{ name?: string; id?: string }>;
};

type DnsRecord = {
  id?: string;
  name?: string;
  content?: string;
  type?: string;
};

const CNAME_CONFLICT_RECORD_TYPES = new Set(["A", "AAAA"]);

type TunnelResponse = {
  id?: string;
  name?: string;
  tunnel_secret?: string;
  token?: string;
  deleted_at?: string | null;
  created_at?: string;
};

function clean(value: unknown): string | undefined {
  if (value == null) return undefined;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : undefined;
}

function isEnabled(value: unknown): boolean {
  if (value === true) return true;
  if (value == null) return false;
  const lowered = String(value).trim().toLowerCase();
  if (!lowered) return false;
  return !["0", "false", "no", "off"].includes(lowered);
}

function normalizeCloudflareMode(
  value: unknown,
): "none" | "self" | "managed" | undefined {
  const raw = clean(value)?.toLowerCase();
  if (raw === "none" || raw === "self" || raw === "managed") {
    return raw;
  }
  return undefined;
}

function cloudflareSelfMode(settings: any): boolean {
  const mode = normalizeCloudflareMode(settings.cloudflare_mode);
  const tunnelEnabled = isEnabled(
    settings.project_hosts_cloudflare_tunnel_enabled,
  );
  if (mode === "self") return true;
  if (mode === "managed") return false;
  if (mode === "none") {
    return tunnelEnabled;
  }
  return tunnelEnabled;
}

function normalizePrefix(value: unknown): string | undefined {
  const raw = clean(value);
  if (!raw) return undefined;
  let prefix = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  prefix = prefix.replace(/^-+/, "").replace(/-+$/, "");
  return prefix || undefined;
}

async function getConfig(): Promise<TunnelConfig | undefined> {
  const settings = await getServerSettings();
  if (!cloudflareSelfMode(settings)) {
    return undefined;
  }
  const dns = normalizeCloudflareHostname(settings.dns);
  const accountId = clean(settings.project_hosts_cloudflare_tunnel_account_id);
  const token = clean(settings.project_hosts_cloudflare_tunnel_api_token);
  const prefix = normalizePrefix(
    settings.project_hosts_cloudflare_tunnel_prefix,
  );
  const hostSuffix = deriveProjectHostSuffix(settings);
  if (!dns || !accountId || !token) return undefined;
  return { dns, accountId, token, prefix, hostSuffix };
}

async function getHubConfig(): Promise<HubTunnelConfig | undefined> {
  const settings = await getServerSettings();
  if (!cloudflareSelfMode(settings)) {
    return undefined;
  }
  const accountId = clean(settings.project_hosts_cloudflare_tunnel_account_id);
  const token = clean(settings.project_hosts_cloudflare_tunnel_api_token);
  const hostname = normalizeCloudflareHostname(settings.dns);
  const zone = hostname;
  const prefix = normalizePrefix(
    settings.project_hosts_cloudflare_tunnel_prefix,
  );
  if (!accountId || !token || !zone || !hostname) return undefined;
  return { accountId, token, zone, hostname, prefix };
}

export async function hasCloudflareTunnel(): Promise<boolean> {
  return !!(await getConfig());
}

export async function hasHubCloudflareTunnel(): Promise<boolean> {
  return !!(await getHubConfig());
}

async function cloudflareRequest<T>(
  token: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
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
    signal: AbortSignal.timeout(CLOUDFLARE_API_TIMEOUT_MS),
  });
  if (!response.ok) {
    let details = "";
    try {
      const text = await response.text();
      if (text) {
        try {
          const data = JSON.parse(text) as CloudflareResponse<any>;
          details =
            data?.errors
              ?.map((err) => err.message)
              .filter(Boolean)
              .join(", ") ||
            data?.result?.message ||
            text;
        } catch {
          details = text;
        }
      }
    } catch {
      details = "";
    }
    const suffix = details ? `: ${details}` : "";
    throw new Error(
      `cloudflare api failed: ${method} ${path} -> ${response.status} ${response.statusText}${suffix}`,
    );
  }
  const data = (await response.json()) as CloudflareResponse<T>;
  if (!data?.success) {
    const details =
      data?.errors
        ?.map((err) => err.message)
        .filter(Boolean)
        .join(", ") || "unknown error";
    throw new Error(`cloudflare api failed: ${details}`);
  }
  if (data.result === undefined) {
    throw new Error("cloudflare api returned no result");
  }
  return data.result;
}

function isNotFoundError(err: unknown): boolean {
  const message = String((err as Error)?.message ?? err).toLowerCase();
  return message.includes("not found") || message.includes("404");
}

function isConflictError(err: unknown): boolean {
  const message = String((err as Error)?.message ?? err).toLowerCase();
  return message.includes("409") || message.includes("conflict");
}

const zoneIdCache = new Map<string, string>();
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
    signal: AbortSignal.timeout(CLOUDFLARE_API_TIMEOUT_MS),
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

async function getZoneIdForHostname(
  token: string,
  hostname: string,
): Promise<string> {
  const parts = hostname.split(".").filter(Boolean);
  for (let i = 0; i < parts.length - 1; i += 1) {
    const candidate = parts.slice(i).join(".");
    try {
      return await getZoneId(token, candidate);
    } catch (err) {
      if (!isNotFoundError(err)) {
        throw err;
      }
    }
  }
  throw new Error(`cloudflare zone not found for ${hostname}`);
}

async function listDnsRecords(
  token: string,
  zoneIdValue: string,
  name: string,
): Promise<DnsRecord[]> {
  const qs = new URLSearchParams({ type: "CNAME", name });
  return await cloudflareRequest<DnsRecord[]>(
    token,
    "GET",
    `zones/${zoneIdValue}/dns_records?${qs.toString()}`,
  );
}

async function listDnsRecordsByName(
  token: string,
  zoneIdValue: string,
  name: string,
): Promise<DnsRecord[]> {
  const qs = new URLSearchParams({ name });
  return await cloudflareRequest<DnsRecord[]>(
    token,
    "GET",
    `zones/${zoneIdValue}/dns_records?${qs.toString()}`,
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

async function ensureTunnelDns(opts: {
  token: string;
  zoneId: string;
  hostname: string;
  target: string;
  record_id?: string;
}): Promise<string> {
  const updateRecord = async (record_id: string) => {
    const newData = {
      type: "CNAME",
      content: opts.target,
      name: opts.hostname,
      ttl: TTL,
      proxied: true,
    } as const;
    await cloudflareRequest(
      opts.token,
      "PUT",
      `zones/${opts.zoneId}/dns_records/${record_id}`,
      newData,
    );
  };

  const createRecord = async () => {
    const record = {
      type: "CNAME",
      name: opts.hostname,
      content: opts.target,
      ttl: TTL,
      proxied: true,
    } as const;
    const response = await cloudflareRequest<{ id?: string }>(
      opts.token,
      "POST",
      `zones/${opts.zoneId}/dns_records`,
      record,
    );
    const record_id = response?.id;
    if (!record_id) {
      throw new Error("cloudflare did not return record id");
    }
    return record_id;
  };

  let records = await listDnsRecords(opts.token, opts.zoneId, opts.hostname);
  let recordIds = records
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
        token: opts.token,
        zoneId: opts.zoneId,
        hostname: opts.hostname,
      });
      record_id = await createRecord();
      records = [];
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
          opts.token,
          "DELETE",
          `zones/${opts.zoneId}/dns_records/${id}`,
        );
      } catch (err) {
        if (!isNotFoundError(err)) {
          throw err;
        }
      }
    }
  }

  await deleteAddressRecordsConflictingWithCname({
    token: opts.token,
    zoneId: opts.zoneId,
    hostname: opts.hostname,
    keepRecordId: record_id,
  });

  if (record_id) {
    try {
      await updateRecord(record_id);
    } catch (err) {
      if (isNotFoundError(err)) {
        record_id = await createRecord();
      } else {
        throw err;
      }
    }
  }

  return record_id;
}

async function fetchTunnel(
  accountId: string,
  token: string,
  tunnelId: string,
): Promise<TunnelResponse | undefined> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(CLOUDFLARE_API_TIMEOUT_MS),
    },
  );
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(
      `cloudflare tunnel lookup failed: ${response.status} ${response.statusText}`,
    );
  }
  const data = (await response.json()) as CloudflareResponse<TunnelResponse>;
  if (!data?.success) {
    const details =
      data?.errors
        ?.map((err) => err.message)
        .filter(Boolean)
        .join(", ") || "unknown error";
    throw new Error(`cloudflare tunnel lookup failed: ${details}`);
  }
  return data.result;
}

async function createTunnel(
  accountId: string,
  token: string,
  name: string,
  tunnelSecret: string,
): Promise<TunnelResponse> {
  return await cloudflareRequest<TunnelResponse>(
    token,
    "POST",
    `accounts/${accountId}/cfd_tunnel`,
    {
      name,
      config_src: "local",
      tunnel_secret: tunnelSecret,
    },
  );
}

async function listTunnelsByName(
  accountId: string,
  token: string,
  name: string,
): Promise<TunnelResponse[]> {
  const qs = new URLSearchParams({ name });
  return await cloudflareRequest<TunnelResponse[]>(
    token,
    "GET",
    `accounts/${accountId}/cfd_tunnel?${qs.toString()}`,
  );
}

async function getTunnelToken(
  accountId: string,
  token: string,
  tunnelId: string,
): Promise<string | undefined> {
  const response = await cloudflareRequest<any>(
    token,
    "GET",
    `accounts/${accountId}/cfd_tunnel/${tunnelId}/token`,
  );
  if (typeof response === "string") return response;
  if (response && typeof response.token === "string") return response.token;
  return undefined;
}

export async function ensureCloudflareTunnelForHost(opts: {
  host_id: string;
  existing?: CloudflareTunnel;
  publish_browser_dns?: boolean;
}): Promise<CloudflareTunnel | undefined> {
  const config = await getConfig();
  if (!config) return opts.existing;
  const hostname = config.hostSuffix
    ? `host-${opts.host_id}${config.hostSuffix}`
    : undefined;
  const sshHostname = config.hostSuffix
    ? `ssh-host-${opts.host_id}${config.hostSuffix}`
    : undefined;
  if (!hostname || !sshHostname) return opts.existing;
  const prefix = config.prefix ? `${config.prefix}-` : "";
  return await ensureCloudflareTunnel({
    accountId: config.accountId,
    token: config.token,
    zone: config.dns,
    hostname,
    ssh_hostname: sshHostname,
    name: `${prefix}host-${opts.host_id}`,
    existing: opts.existing,
    publish_browser_dns: opts.publish_browser_dns,
    logContext: { host_id: opts.host_id },
  });
}

export async function ensureCloudflareTunnelForBay(opts: {
  bay_id: string;
  existing?: CloudflareTunnel;
}): Promise<CloudflareTunnel | undefined> {
  const config = await getHubConfig();
  if (!config) return undefined;
  const hostname = await getDerivedBayPublicHostname(opts.bay_id);
  if (!hostname) {
    return undefined;
  }
  const prefix = config.prefix ? `${config.prefix}-` : "";
  const name = `${prefix}bay-${opts.bay_id}`;
  return await ensureCloudflareTunnel({
    accountId: config.accountId,
    token: config.token,
    zone: config.hostname,
    hostname,
    name,
    existing: opts.existing,
    logContext: { bay_id: opts.bay_id, hostname },
  });
}

async function ensureCloudflareTunnel(opts: {
  accountId: string;
  token: string;
  zone: string;
  hostname: string;
  ssh_hostname?: string;
  name: string;
  existing?: CloudflareTunnel;
  publish_browser_dns?: boolean;
  logContext?: Record<string, unknown>;
}): Promise<CloudflareTunnel> {
  let tunnelId = opts.existing?.id;
  let tunnelName = opts.existing?.name ?? opts.name;
  let tunnelSecret = opts.existing?.tunnel_secret;
  let created: TunnelResponse | undefined;

  if (tunnelId) {
    try {
      const info = await fetchTunnel(opts.accountId, opts.token, tunnelId);
      if (!info?.id || info.deleted_at) {
        tunnelId = undefined;
        tunnelName = opts.name;
        tunnelSecret = undefined;
      } else {
        tunnelName = info.name ?? tunnelName;
      }
    } catch (err) {
      if (!isNotFoundError(err)) {
        throw err;
      }
      tunnelId = undefined;
      tunnelName = opts.name;
      tunnelSecret = undefined;
    }
  }

  if (!tunnelId) {
    const generatedSecret = crypto.randomBytes(32).toString("base64");
    try {
      created = await createTunnel(
        opts.accountId,
        opts.token,
        tunnelName || opts.name,
        generatedSecret,
      );
    } catch (err) {
      if (!isConflictError(err)) {
        throw err;
      }
      const existing = await listTunnelsByName(
        opts.accountId,
        opts.token,
        tunnelName || opts.name,
      );
      const reusable = existing.find(
        (tunnel) => !!tunnel.id && !tunnel.deleted_at,
      );
      if (!reusable?.id) {
        throw err;
      }
      tunnelId = reusable.id;
      tunnelName = reusable.name ?? tunnelName ?? opts.name;
      logger.info("cloudflare tunnel adopted by name", {
        tunnel_id: tunnelId,
        ...opts.logContext,
      });
    }
    if (created) {
      if (!created.id) {
        throw new Error("cloudflare tunnel create returned no id");
      }
      tunnelId = created.id;
      tunnelName = created.name ?? tunnelName ?? opts.name;
      tunnelSecret = created.tunnel_secret ?? generatedSecret;
      logger.info("cloudflare tunnel created", {
        tunnel_id: tunnelId,
        ...opts.logContext,
      });
    }
  }
  if (!tunnelId) {
    throw new Error("cloudflare tunnel has no id after reconciliation");
  }
  const activeTunnelId = tunnelId;

  let zoneIdValue: string;
  try {
    zoneIdValue = await getZoneId(opts.token, opts.zone);
  } catch (err) {
    if (!isNotFoundError(err)) {
      throw err;
    }
    zoneIdValue = await getZoneIdForHostname(opts.token, opts.hostname);
  }
  // Direct project-host ingress still keeps a ready tunnel for rollback and
  // SSH, but its browser hostname must remain a proxied A record.
  const record_id =
    opts.publish_browser_dns === false
      ? opts.existing?.record_id
      : await ensureTunnelDns({
          token: opts.token,
          zoneId: zoneIdValue,
          hostname: opts.hostname,
          target: `${activeTunnelId}.cfargotunnel.com`,
          record_id: opts.existing?.record_id,
        });
  let ssh_record_id: string | undefined;
  if (opts.ssh_hostname) {
    ssh_record_id = await ensureTunnelDns({
      token: opts.token,
      zoneId: zoneIdValue,
      hostname: opts.ssh_hostname,
      target: `${activeTunnelId}.cfargotunnel.com`,
      record_id: opts.existing?.ssh_record_id,
    });
  }
  let token: string | undefined =
    (typeof created?.token === "string" ? created.token : undefined) ??
    undefined;
  if (!token) {
    try {
      token = await getTunnelToken(opts.accountId, opts.token, activeTunnelId);
    } catch (err) {
      logger.warn("cloudflare tunnel token fetch failed", {
        err,
        ...opts.logContext,
      });
    }
  }
  if (!token && !tunnelSecret) {
    throw new Error(
      `cloudflare tunnel ${activeTunnelId} has neither a connector token nor local credentials`,
    );
  }

  return {
    id: activeTunnelId,
    name: tunnelName ?? opts.name,
    hostname: opts.hostname,
    tunnel_secret: tunnelSecret ?? "",
    account_id: opts.accountId,
    record_id,
    ssh_hostname: opts.ssh_hostname,
    ssh_record_id,
    token,
  };
}

export async function ensureCloudflareTunnelForHub(opts?: {
  existing?: CloudflareTunnel;
}): Promise<CloudflareTunnel | undefined> {
  const config = await getHubConfig();
  if (!config) return undefined;
  if (!config.hostname.endsWith(config.zone)) {
    throw new Error(
      `External Domain Name '${config.hostname}' must end with '${config.zone}' for Cloudflare tunnel automation.`,
    );
  }
  const prefix = config.prefix ? `${config.prefix}-` : "";
  const name = `${prefix}hub-${config.hostname.replace(/[^a-z0-9-]/g, "-")}`;
  return await ensureCloudflareTunnel({
    accountId: config.accountId,
    token: config.token,
    zone: config.zone,
    hostname: config.hostname,
    name,
    existing: opts?.existing,
    logContext: { hostname: config.hostname },
  });
}

export async function ensureCloudflareTunnelHostname({
  tunnel,
  hostname,
}: {
  tunnel: CloudflareTunnel;
  hostname: string;
}): Promise<void> {
  const config = await getHubConfig();
  const normalizedHostname = normalizeCloudflareHostname(hostname);
  if (!config || !normalizedHostname) return;
  if (
    normalizedHostname !== config.zone &&
    !normalizedHostname.endsWith(`.${config.zone}`)
  ) {
    throw new Error(
      `Cloudflare tunnel hostname '${normalizedHostname}' must be within '${config.zone}'.`,
    );
  }
  const zoneId = await getZoneIdForHostname(config.token, normalizedHostname);
  await ensureTunnelDns({
    token: config.token,
    zoneId,
    hostname: normalizedHostname,
    target: `${tunnel.id}.cfargotunnel.com`,
  });
}

export async function deleteCloudflareTunnel(opts: {
  host_id?: string;
  tunnel?: CloudflareTunnel;
}): Promise<void> {
  const config = await getConfig();
  if (!config) return;
  const hostname =
    opts.tunnel?.hostname ??
    (opts.host_id && config.hostSuffix
      ? `host-${opts.host_id}${config.hostSuffix}`
      : undefined);
  const sshHostname =
    opts.tunnel?.ssh_hostname ??
    (opts.host_id && config.hostSuffix
      ? `ssh-host-${opts.host_id}${config.hostSuffix}`
      : undefined);
  const prefix = config.prefix ? `${config.prefix}-` : "";
  const tunnelName = opts.host_id
    ? `${prefix}host-${opts.host_id}`
    : opts.tunnel?.name;
  let zoneIdValue: string | undefined;
  try {
    zoneIdValue = await getZoneIdForHostname(
      config.token,
      hostname ?? config.dns,
    );
  } catch (err) {
    logger.warn("cloudflare tunnel zone lookup failed; skipping dns cleanup", {
      err,
      hostname: hostname ?? config.dns,
    });
  }

  if (zoneIdValue && opts.tunnel?.record_id) {
    try {
      await cloudflareRequest(
        config.token,
        "DELETE",
        `zones/${zoneIdValue}/dns_records/${opts.tunnel.record_id}`,
      );
    } catch (err) {
      if (!isNotFoundError(err)) {
        logger.warn("cloudflare tunnel dns delete failed", { err });
      }
    }
  }
  if (zoneIdValue && hostname) {
    try {
      // Bootstrap can recreate a record after the stored id was captured.
      // Always remove any exact-name remainder after the best-effort id delete.
      const records = await listDnsRecordsByName(
        config.token,
        zoneIdValue,
        hostname,
      );
      for (const record of records) {
        if (!record.id) continue;
        try {
          await cloudflareRequest(
            config.token,
            "DELETE",
            `zones/${zoneIdValue}/dns_records/${record.id}`,
          );
        } catch (err) {
          if (!isNotFoundError(err)) {
            logger.warn("cloudflare tunnel dns delete failed", { err });
          }
        }
      }
    } catch (err) {
      logger.warn("cloudflare tunnel dns lookup failed", { err });
    }
  }
  if (zoneIdValue && opts.tunnel?.ssh_record_id) {
    try {
      await cloudflareRequest(
        config.token,
        "DELETE",
        `zones/${zoneIdValue}/dns_records/${opts.tunnel.ssh_record_id}`,
      );
    } catch (err) {
      if (!isNotFoundError(err)) {
        logger.warn("cloudflare tunnel ssh dns delete failed", { err });
      }
    }
  }
  if (zoneIdValue && sshHostname) {
    try {
      const records = await listDnsRecordsByName(
        config.token,
        zoneIdValue,
        sshHostname,
      );
      for (const record of records) {
        if (!record.id) continue;
        try {
          await cloudflareRequest(
            config.token,
            "DELETE",
            `zones/${zoneIdValue}/dns_records/${record.id}`,
          );
        } catch (err) {
          if (!isNotFoundError(err)) {
            logger.warn("cloudflare tunnel ssh dns delete failed", { err });
          }
        }
      }
    } catch (err) {
      logger.warn("cloudflare tunnel ssh dns lookup failed", { err });
    }
  }

  const tunnelIds = new Set<string>();
  if (opts.tunnel?.id) {
    tunnelIds.add(opts.tunnel.id);
  }
  if (tunnelName) {
    try {
      const tunnels = await listTunnelsByName(
        config.accountId,
        config.token,
        tunnelName,
      );
      for (const tunnel of tunnels) {
        if (tunnel.id && !tunnel.deleted_at) {
          tunnelIds.add(tunnel.id);
        }
      }
    } catch (err) {
      logger.warn("cloudflare tunnel lookup during delete failed", {
        err,
        tunnel_name: tunnelName,
      });
    }
  }
  for (const tunnelId of tunnelIds) {
    try {
      // Cloudflare can retain disconnected connectors for several minutes.
      // Remove those tracked connections before deleting the host tunnel.
      await cloudflareRequest(
        config.token,
        "DELETE",
        `accounts/${config.accountId}/cfd_tunnel/${tunnelId}/connections`,
      );
    } catch (err) {
      if (!isNotFoundError(err)) {
        logger.warn("cloudflare tunnel connection cleanup failed", {
          err,
          tunnel_id: tunnelId,
        });
      }
    }
    try {
      await cloudflareRequest(
        config.token,
        "DELETE",
        `accounts/${config.accountId}/cfd_tunnel/${tunnelId}`,
      );
    } catch (err) {
      if (!isNotFoundError(err)) {
        logger.warn("cloudflare tunnel delete failed", {
          err,
          tunnel_id: tunnelId,
        });
      }
    }
  }
}
