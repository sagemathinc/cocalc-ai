import getLogger from "@cocalc/backend/logger";
import crypto from "node:crypto";
import { getServerSettings } from "@cocalc/database/settings/server-settings";

const logger = getLogger("server:cloud:cloudflare-tunnel");
const TTL = 120;

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

type TunnelResponse = {
  id?: string;
  name?: string;
  tunnel_secret?: string;
  token?: string;
};

function clean(value: unknown): string | undefined {
  if (value == null) return undefined;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : undefined;
}

function normalizeHostname(value: unknown): string | undefined {
  const raw = clean(value);
  if (!raw) return undefined;
  let host = raw;
  if (host.startsWith("http://") || host.startsWith("https://")) {
    try {
      host = new URL(host).host;
    } catch {
      host = host.replace(/^https?:\/\//, "");
    }
  }
  host = host.split("/")[0];
  if (host.includes(":")) {
    host = host.split(":")[0];
  }
  return host || undefined;
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

function normalizeHostSuffix(value: unknown): string | undefined {
  const raw = clean(value);
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const lead = trimmed[0];
  const prefix = lead === "." || lead === "-" ? lead : "-";
  const rest = prefix ? trimmed.slice(1) : trimmed;
  const host = normalizeHostname(rest) ?? clean(rest);
  if (!host) return undefined;
  return `${prefix}${host}`;
}

async function getConfig(): Promise<TunnelConfig | undefined> {
  const settings = await getServerSettings();
  if (!cloudflareSelfMode(settings)) {
    return undefined;
  }
  const dns = clean(settings.project_hosts_dns);
  const accountId = clean(settings.project_hosts_cloudflare_tunnel_account_id);
  const token = clean(settings.project_hosts_cloudflare_tunnel_api_token);
  const prefix = normalizePrefix(
    settings.project_hosts_cloudflare_tunnel_prefix,
  );
  const externalDomain = normalizeHostname(settings.dns);
  const defaultSuffix = externalDomain ? `-${externalDomain}` : undefined;
  const hostSuffix =
    normalizeHostSuffix(settings.project_hosts_cloudflare_tunnel_host_suffix) ??
    normalizeHostSuffix(defaultSuffix);
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
  const zone = clean(settings.project_hosts_dns);
  const hostname = normalizeHostname(settings.dns);
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

  const otherRecords = await listDnsRecordsByName(
    opts.token,
    opts.zoneId,
    opts.hostname,
  );
  for (const record of otherRecords) {
    if (!record.id) continue;
    if (record.id === record_id) continue;
    if (record.type?.toUpperCase() === "CNAME") continue;
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

async function deleteTunnel(
  accountId: string,
  token: string,
  tunnelId: string,
): Promise<void> {
  await cloudflareRequest(
    token,
    "DELETE",
    `accounts/${accountId}/cfd_tunnel/${tunnelId}`,
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
}): Promise<CloudflareTunnel | undefined> {
  const config = await getConfig();
  if (!config) return undefined;
  const suffix = config.hostSuffix ?? `.${config.dns}`;
  const hostname = `host-${opts.host_id}${suffix}`;
  const sshHostname = `ssh-host-${opts.host_id}${suffix}`;
  const prefix = config.prefix ? `${config.prefix}-` : "";
  return await ensureCloudflareTunnel({
    accountId: config.accountId,
    token: config.token,
    zone: config.dns,
    hostname,
    ssh_hostname: sshHostname,
    name: `${prefix}host-${opts.host_id}`,
    existing: opts.existing,
    logContext: { host_id: opts.host_id },
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
  logContext?: Record<string, unknown>;
}): Promise<CloudflareTunnel> {
  let tunnelId = opts.existing?.id;
  let tunnelName = opts.existing?.name ?? opts.name;
  let tunnelSecret = opts.existing?.tunnel_secret;
  let created: TunnelResponse | undefined;

  if (tunnelId) {
    try {
      const info = await fetchTunnel(opts.accountId, opts.token, tunnelId);
      if (!info?.id) {
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

  if (!tunnelId || !tunnelSecret) {
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
      for (const tunnel of existing) {
        if (!tunnel.id) continue;
        try {
          await deleteTunnel(opts.accountId, opts.token, tunnel.id);
        } catch (deleteErr) {
          if (!isNotFoundError(deleteErr)) {
            throw deleteErr;
          }
        }
      }
      created = await createTunnel(
        opts.accountId,
        opts.token,
        tunnelName || opts.name,
        generatedSecret,
      );
    }
    if (!created?.id || !created?.tunnel_secret) {
      if (!created?.id) {
        throw new Error("cloudflare tunnel create returned no id");
      }
    }
    tunnelId = created.id;
    tunnelName = created.name ?? tunnelName ?? opts.name;
    tunnelSecret = created.tunnel_secret ?? generatedSecret;
    logger.info("cloudflare tunnel created", {
      tunnel_id: tunnelId,
      ...opts.logContext,
    });
  }

  let zoneIdValue: string;
  try {
    zoneIdValue = await getZoneId(opts.token, opts.zone);
  } catch (err) {
    if (!isNotFoundError(err)) {
      throw err;
    }
    zoneIdValue = await getZoneIdForHostname(opts.token, opts.hostname);
  }
  const record_id = await ensureTunnelDns({
    token: opts.token,
    zoneId: zoneIdValue,
    hostname: opts.hostname,
    target: `${tunnelId}.cfargotunnel.com`,
    record_id: opts.existing?.record_id,
  });
  let ssh_record_id: string | undefined;
  if (opts.ssh_hostname) {
    ssh_record_id = await ensureTunnelDns({
      token: opts.token,
      zoneId: zoneIdValue,
      hostname: opts.ssh_hostname,
      target: `${tunnelId}.cfargotunnel.com`,
      record_id: opts.existing?.ssh_record_id,
    });
  }
  let token: string | undefined =
    (typeof created?.token === "string" ? created.token : undefined) ??
    undefined;
  if (!token) {
    try {
      token = await getTunnelToken(opts.accountId, opts.token, tunnelId);
    } catch (err) {
      logger.warn("cloudflare tunnel token fetch failed", {
        err,
        ...opts.logContext,
      });
    }
  }

  return {
    id: tunnelId,
    name: tunnelName ?? opts.name,
    hostname: opts.hostname,
    tunnel_secret: tunnelSecret,
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

export async function deleteCloudflareTunnel(opts: {
  host_id?: string;
  tunnel?: CloudflareTunnel;
}): Promise<void> {
  const config = await getConfig();
  if (!config) return;
  const hostname =
    opts.tunnel?.hostname ??
    (opts.host_id ? `host-${opts.host_id}.${config.dns}` : undefined);
  const sshHostname = opts.tunnel?.ssh_hostname;
  let zoneIdValue: string | undefined;
  try {
    zoneIdValue = await getZoneId(config.token, config.dns);
  } catch (err) {
    logger.warn("cloudflare tunnel zone lookup failed; skipping dns cleanup", {
      err,
      dns: config.dns,
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
  } else if (zoneIdValue && hostname) {
    try {
      const records = await listDnsRecords(config.token, zoneIdValue, hostname);
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
  } else if (zoneIdValue && sshHostname) {
    try {
      const records = await listDnsRecordsByName(config.token, zoneIdValue, sshHostname);
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

  if (opts.tunnel?.id) {
    try {
      await cloudflareRequest(
        config.token,
        "DELETE",
        `accounts/${config.accountId}/cfd_tunnel/${opts.tunnel.id}`,
      );
    } catch (err) {
      if (!isNotFoundError(err)) {
        logger.warn("cloudflare tunnel delete failed", { err });
      }
    }
  }
}
