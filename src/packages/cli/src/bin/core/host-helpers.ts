/**
 * Host command helper primitives.
 *
 * This module centralizes host option parsing, catalog summarization, and host
 * readiness/SSH endpoint resolution used by CLI host operations.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type {
  HostCatalog,
  HostCatalogEntry,
  HostMachine,
  HostSoftwareArtifact,
  HostSoftwareChannel,
} from "@cocalc/conat/hub/api/hosts";

export const HOST_CREATE_DISK_TYPES = new Set(["ssd", "balanced", "ssd_io_m3"]);
export const HOST_CREATE_STORAGE_MODES = new Set(["persistent", "ephemeral"]);
const HOST_CREATE_READY_STATUSES = new Set(["running", "active"]);
const HOST_CREATE_FAILED_STATUSES = new Set(["error", "deprovisioned"]);

type HostLike = {
  id: string;
  status?: string | null;
  last_seen?: string | null;
  last_action_error?: string | null;
  last_error?: string | null;
  public_ip?: string | null;
  private_ip?: string | null;
  public_url?: string | null;
  internal_url?: string | null;
  machine?: Record<string, any> | null;
  bootstrap?: {
    status?: string | null;
    updated_at?: string | null;
    message?: string | null;
  } | null;
};

export type HostCreateProgress<Host extends HostLike> = {
  host: Host;
  status: string;
  hasHeartbeat: boolean;
  bootstrapStatus?: string;
  bootstrapMessage?: string;
  bootstrapUpdatedAt?: string;
};

type HostHelpersDeps<Ctx, Host extends HostLike> = {
  listHosts: (
    ctx: Ctx,
    opts?: {
      include_deleted?: boolean;
      catalog?: boolean;
      admin_view?: boolean;
    },
  ) => Promise<Host[]>;
  resolveHost: (ctx: Ctx, identifier: string) => Promise<Host>;
  parseSshServer: (value: string) => { host: string; port?: number | null };
  cliDebug: (...args: unknown[]) => void;
  hostSshResolveTimeoutMs?: number;
  lookupHost?: (hostname: string) => Promise<{ address: string }>;
};

export function normalizeHostSoftwareArtifactValue(
  value: string,
): HostSoftwareArtifact {
  const normalized = value.trim().toLowerCase();
  if (normalized === "project-host" || normalized === "host") {
    return "project-host";
  }
  if (
    normalized === "container-runtime" ||
    normalized === "container" ||
    normalized === "podman" ||
    normalized === "runtime"
  ) {
    return "container-runtime";
  }
  if (
    normalized === "project" ||
    normalized === "project-bundle" ||
    normalized === "bundle"
  ) {
    return "project";
  }
  if (normalized === "tools" || normalized === "tool") {
    return "tools";
  }
  if (
    normalized === "bootstrap-environment" ||
    normalized === "bootstrap" ||
    normalized === "bootstrap-env"
  ) {
    return "bootstrap-environment";
  }
  throw new Error(
    `invalid artifact '${value}'; expected one of: project-host, container-runtime, project, tools, bootstrap-environment`,
  );
}

export function parseHostSoftwareArtifactsOption(
  values?: string[],
): HostSoftwareArtifact[] {
  if (!values?.length) {
    // Container runtime upgrades are intentionally never implicit.
    return ["project-host", "project", "tools"];
  }
  const artifacts = values.map((value) =>
    normalizeHostSoftwareArtifactValue(value),
  );
  return Array.from(new Set(artifacts));
}

export function parseHostSoftwareChannelsOption(
  values?: string[],
): HostSoftwareChannel[] {
  if (!values?.length) {
    return ["latest"];
  }
  const channels = values.map((value) => {
    const normalized = value.trim().toLowerCase();
    if (normalized === "latest" || normalized === "stable") return "latest";
    if (normalized === "staging") return "staging";
    throw new Error(
      `invalid channel '${value}'; expected one of: latest, staging`,
    );
  });
  return Array.from(new Set(channels));
}

export function normalizeHostProviderValue(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new Error("--provider must not be empty");
  }
  if (normalized === "google" || normalized === "google-cloud") {
    return "gcp";
  }
  if (normalized === "self" || normalized === "self_host") {
    return "self-host";
  }
  return normalized;
}

export function parseHostMachineJson(value?: string): Partial<HostMachine> {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `--machine-json must be valid JSON object: ${
        err instanceof Error ? err.message : `${err}`
      }`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--machine-json must be a JSON object");
  }
  return { ...(parsed as Partial<HostMachine>) };
}

export function parseOptionalPositiveInteger(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value == null || `${value}`.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export function inferRegionFromZone(
  zone: string | undefined,
): string | undefined {
  const raw = `${zone ?? ""}`.trim();
  if (!raw) return undefined;
  const parts = raw.split("-").filter(Boolean);
  if (parts.length >= 3 && parts[parts.length - 1].length === 1) {
    return parts.slice(0, -1).join("-");
  }
  return undefined;
}

function summarizeCatalogPayload(payload: unknown): string {
  if (payload == null) return "null";
  if (Array.isArray(payload)) {
    if (payload.length === 0) return "0 items";
    const named = payload
      .slice(0, 3)
      .map((item) =>
        item && typeof item === "object"
          ? `${(item as any).name ?? ""}`.trim()
          : "",
      )
      .filter(Boolean);
    if (named.length > 0) {
      return `${payload.length} items (${named.join(", ")}${
        payload.length > named.length ? ", ..." : ""
      })`;
    }
    return `${payload.length} items`;
  }
  if (typeof payload === "object") {
    const keys = Object.keys(payload as Record<string, unknown>);
    if (!keys.length) return "0 keys";
    const preview = keys.slice(0, 4).join(", ");
    return `${keys.length} keys (${preview}${keys.length > 4 ? ", ..." : ""})`;
  }
  return `${payload}`;
}

export function summarizeHostCatalogEntries(
  catalog: HostCatalog,
  kinds?: string[],
): Array<Record<string, unknown>> {
  const wantedKinds = new Set(
    (kinds ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean),
  );
  const entries = (catalog.entries ?? []).filter((entry) =>
    wantedKinds.size
      ? wantedKinds.has(`${entry.kind ?? ""}`.toLowerCase())
      : true,
  );
  return entries.map((entry: HostCatalogEntry) => ({
    provider: catalog.provider,
    kind: entry.kind,
    scope: entry.scope,
    summary: summarizeCatalogPayload(entry.payload),
  }));
}

export function createHostHelpers<Ctx, Host extends HostLike>(
  deps: HostHelpersDeps<Ctx, Host>,
) {
  const { listHosts, resolveHost, cliDebug } = deps;
  const hostSshResolveTimeoutMs = deps.hostSshResolveTimeoutMs ?? 5_000;

  function resolveHostSshUser(host: Host): string {
    const machine = (host.machine ?? {}) as Record<string, any>;
    const metadata = (machine?.metadata ?? {}) as Record<string, any>;
    const runtime = (metadata?.runtime ?? (host as any)?.runtime ?? {}) as
      | Record<string, any>
      | undefined;
    return (
      `${runtime?.ssh_user ?? metadata?.ssh_user ?? ""}`.trim() || "ubuntu"
    );
  }

  async function waitForHostCreateReady(
    ctx: Ctx,
    hostId: string,
    {
      timeoutMs,
      pollMs,
      onProgress,
    }: {
      timeoutMs: number;
      pollMs: number;
      onProgress?: (progress: HostCreateProgress<Host>) => void;
    },
  ): Promise<{ host: Host; timedOut: boolean }> {
    const started = Date.now();
    let lastHost: Host | undefined;
    let lastProgressKey = "";
    while (Date.now() - started <= timeoutMs) {
      const hosts = await listHosts(ctx, {
        include_deleted: true,
        catalog: true,
      });
      const host = hosts.find((x) => x.id === hostId);
      if (!host) {
        throw new Error(`host '${hostId}' no longer exists`);
      }
      lastHost = host;
      const status = `${host.status ?? ""}`.trim().toLowerCase();
      const hasHeartbeat = `${host.last_seen ?? ""}`.trim() !== "";
      const bootstrapStatus =
        `${host.bootstrap?.status ?? ""}`.trim() || undefined;
      const bootstrapMessage =
        `${host.bootstrap?.message ?? ""}`.trim() || undefined;
      const bootstrapUpdatedAt =
        `${host.bootstrap?.updated_at ?? ""}`.trim() || undefined;
      const progressKey = JSON.stringify({
        status,
        hasHeartbeat,
        bootstrapStatus,
        bootstrapMessage,
        bootstrapUpdatedAt,
      });
      if (progressKey !== lastProgressKey) {
        lastProgressKey = progressKey;
        onProgress?.({
          host,
          status,
          hasHeartbeat,
          bootstrapStatus,
          bootstrapMessage,
          bootstrapUpdatedAt,
        });
      }
      if (HOST_CREATE_READY_STATUSES.has(status) && hasHeartbeat) {
        return { host, timedOut: false };
      }
      if (HOST_CREATE_FAILED_STATUSES.has(status)) {
        const detail =
          `${host.last_action_error ?? host.last_error ?? ""}`.trim();
        throw new Error(
          `host create failed: status=${status}${detail ? ` error=${detail}` : ""}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    if (!lastHost) {
      throw new Error(`host '${hostId}' not found`);
    }
    return { host: lastHost, timedOut: true };
  }

  async function resolveHostSshEndpoint(
    ctx: Ctx,
    hostIdentifier: string,
    network = "auto",
  ): Promise<{
    host: Host;
    ssh_host: string;
    ssh_port: number | null;
    ssh_server: string | null;
    ssh_user: string;
    network: "private" | "public";
    requested_network: string;
    resolved_ip: string | null;
    selection_reason: string;
  }> {
    if (!["private", "public", "auto"].includes(network)) {
      throw new Error("--network must be private, public, or auto");
    }
    const host = await resolveHost(ctx, hostIdentifier);
    const ssh_user = resolveHostSshUser(host);
    const machine = (host.machine ?? {}) as Record<string, any>;
    const configuredPort = Number(machine?.metadata?.ssh_port);
    const port =
      Number.isInteger(configuredPort) &&
      configuredPort > 0 &&
      configuredPort <= 65535
        ? configuredPort
        : 22;
    const endpoint = (
      hostname: string,
      selected: "private" | "public",
      address: string | null,
      reason: string,
    ) => ({
      host,
      ssh_host: hostname,
      ssh_port: port,
      ssh_server: `${isIP(hostname) === 6 ? `[${hostname}]` : hostname}:${port}`,
      ssh_user,
      network: selected,
      requested_network: network,
      resolved_ip: address,
      selection_reason: reason,
    });
    const resolveAddress = async (hostname: string): Promise<string> => {
      if (isIP(hostname)) return hostname;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          (deps.lookupHost ?? lookup)(hostname),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("private host DNS lookup timed out")),
              hostSshResolveTimeoutMs,
            );
          }),
        ]);
        return result.address;
      } finally {
        clearTimeout(timer);
      }
    };
    const publicIp =
      `${host.public_ip ?? machine.metadata?.runtime?.public_ip ?? machine.metadata?.public_ip ?? ""}`.trim();
    const hostnameOf = (value: string): string => {
      try {
        return new URL(value).hostname
          .replace(/^\[|\]$/g, "")
          .toLowerCase()
          .replace(/\.$/, "");
      } catch {
        return "";
      }
    };
    const publicHostname = hostnameOf(host.public_url ?? "");
    let privateError = "no private endpoint in host metadata";
    if (network !== "public") {
      if (host.internal_url) {
        try {
          const url = new URL(host.internal_url);
          if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
            throw new Error("invalid internal_url");
          }
          // This is a host name discovery source, not an SSH port source.
          const hostname = url.hostname.replace(/^\[|\]$/g, "");
          // Public routing mode intentionally copies public_url to internal_url.
          // Compare hostnames, not full URLs: HTTP scheme/port are irrelevant.
          if (
            hostnameOf(host.internal_url) === publicHostname ||
            hostname === publicIp
          ) {
            throw new Error("internal_url aliases the public endpoint");
          }
          const address = await resolveAddress(hostname);
          if (address === publicIp) {
            throw new Error("internal_url resolves to the public IP");
          }
          return endpoint(
            hostname,
            "private",
            address,
            "internal_url hostname resolved; DNS resolution does not guarantee SSH reachability",
          );
        } catch (err) {
          privateError = err instanceof Error ? err.message : String(err);
        }
      }
      const privateIp =
        `${host.private_ip ?? machine.metadata?.runtime?.private_ip ?? ""}`.trim();
      if (isIP(privateIp) && privateIp !== publicIp) {
        return endpoint(privateIp, "private", privateIp, "provider private_ip");
      }
      if (network === "private") {
        throw new Error(
          `private SSH endpoint unavailable: ${privateError}; refusing public fallback`,
        );
      }
      cliDebug("host ssh: private endpoint unavailable", {
        host_id: host.id,
        reason: privateError,
      });
    }
    if (publicIp) {
      return endpoint(
        publicIp,
        "public",
        isIP(publicIp) ? publicIp : null,
        network === "public"
          ? "public network explicitly selected"
          : `auto: ${privateError}`,
      );
    }
    // ssh_server/resolveHostConnection describe project SSH routing, not the
    // administrative host sshd. Never use them as a host-shell fallback.
    throw new Error(
      "host has no administrative SSH endpoint for the selected network",
    );
  }

  return {
    waitForHostCreateReady,
    resolveHostSshEndpoint,
  };
}
