/**
 * Host command helper primitives.
 *
 * This module centralizes host option parsing, catalog summarization, and host
 * readiness/SSH endpoint resolution used by CLI host operations.
 */
import type {
  HostCatalog,
  HostCatalogEntry,
  HostConnectionInfo,
  HostMachine,
  HostSoftwareArtifact,
  HostSoftwareChannel,
} from "@cocalc/conat/hub/api/hosts";

export const HOST_CREATE_DISK_TYPES = new Set([
  "ssd",
  "balanced",
  "standard",
  "ssd_io_m3",
]);
export const HOST_CREATE_STORAGE_MODES = new Set(["persistent", "ephemeral"]);
const HOST_CREATE_READY_STATUSES = new Set(["running", "active"]);
const HOST_CREATE_FAILED_STATUSES = new Set(["error", "deprovisioned"]);

type HostLike = {
  id: string;
  status?: string | null;
  last_action_error?: string | null;
  last_error?: string | null;
  public_ip?: string | null;
  machine?: Record<string, any> | null;
};

type HostHelpersDeps<Ctx, Host extends HostLike> = {
  listHosts: (
    ctx: Ctx,
    opts?: { include_deleted?: boolean; catalog?: boolean; admin_view?: boolean },
  ) => Promise<Host[]>;
  resolveHost: (ctx: Ctx, identifier: string) => Promise<Host>;
  parseSshServer: (value: string) => { host: string; port?: number | null };
  cliDebug: (...args: unknown[]) => void;
  hostSshResolveTimeoutMs?: number;
};

export function normalizeHostSoftwareArtifactValue(value: string): HostSoftwareArtifact {
  const normalized = value.trim().toLowerCase();
  if (normalized === "project-host" || normalized === "host") {
    return "project-host";
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
  throw new Error(
    `invalid artifact '${value}'; expected one of: project-host, project, tools`,
  );
}

export function parseHostSoftwareArtifactsOption(
  values?: string[],
): HostSoftwareArtifact[] {
  if (!values?.length) {
    return ["project-host", "project", "tools"];
  }
  const artifacts = values.map((value) => normalizeHostSoftwareArtifactValue(value));
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
    throw new Error(`invalid channel '${value}'; expected one of: latest, staging`);
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

export function inferRegionFromZone(zone: string | undefined): string | undefined {
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
        item && typeof item === "object" ? `${(item as any).name ?? ""}`.trim() : "",
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
    (kinds ?? [])
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
  );
  const entries = (catalog.entries ?? []).filter((entry) =>
    wantedKinds.size ? wantedKinds.has(`${entry.kind ?? ""}`.toLowerCase()) : true,
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
  const { listHosts, resolveHost, parseSshServer, cliDebug } = deps;
  const hostSshResolveTimeoutMs = deps.hostSshResolveTimeoutMs ?? 5_000;

  async function waitForHostCreateReady(
    ctx: Ctx,
    hostId: string,
    {
      timeoutMs,
      pollMs,
    }: {
      timeoutMs: number;
      pollMs: number;
    },
  ): Promise<{ host: Host; timedOut: boolean }> {
    const started = Date.now();
    let lastHost: Host | undefined;
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
      if (HOST_CREATE_READY_STATUSES.has(status)) {
        return { host, timedOut: false };
      }
      if (HOST_CREATE_FAILED_STATUSES.has(status)) {
        const detail = `${host.last_action_error ?? host.last_error ?? ""}`.trim();
        throw new Error(`host create failed: status=${status}${detail ? ` error=${detail}` : ""}`);
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
  ): Promise<{
    host: Host;
    ssh_host: string;
    ssh_port: number | null;
    ssh_server: string | null;
  }> {
    const host = await resolveHost(ctx, hostIdentifier);
    const machine = (host.machine ?? {}) as Record<string, any>;
    const directHost = `${host.public_ip ?? machine?.metadata?.public_ip ?? ""}`.trim();
    if (directHost) {
      const configuredPort = Number(machine?.metadata?.ssh_port);
      const directPort =
        Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
          ? configuredPort
          : 22;
      return {
        host,
        ssh_host: directHost,
        ssh_port: directPort,
        ssh_server: `${directHost}:${directPort}`,
      };
    }
    let connection: HostConnectionInfo | null = null;
    try {
      connection = await Promise.race([
        (ctx as any).hub.hosts.resolveHostConnection({ host_id: host.id }),
        new Promise<HostConnectionInfo>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `hosts.resolveHostConnection timed out after ${hostSshResolveTimeoutMs}ms`,
                ),
              ),
            hostSshResolveTimeoutMs,
          ),
        ),
      ]);
    } catch (err) {
      cliDebug("host ssh: resolveHostConnection failed, falling back to host ip", {
        host_id: host.id,
        err: err instanceof Error ? err.message : `${err}`,
      });
    }
    if (connection?.ssh_server) {
      const parsed = parseSshServer(connection.ssh_server);
      return {
        host,
        ssh_host: parsed.host,
        ssh_port: parsed.port ?? null,
        ssh_server: connection.ssh_server,
      };
    }
    throw new Error("host has no direct public ip and no routed ssh endpoint");
  }

  return {
    waitForHostCreateReady,
    resolveHostSshEndpoint,
  };
}
