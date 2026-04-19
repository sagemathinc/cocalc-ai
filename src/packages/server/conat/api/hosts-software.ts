import type {
  HostMachine,
  HostSoftwareArtifact,
  HostSoftwareAvailableVersion,
  HostSoftwareChannel,
  HostSoftwareUpgradeResponse,
  HostSoftwareUpgradeTarget,
} from "@cocalc/conat/hub/api/hosts";
import type { ManagedComponentKind } from "@cocalc/conat/project-host/api";
import getLogger from "@cocalc/backend/logger";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import siteURL from "@cocalc/database/settings/site-url";

const logger = getLogger("server:conat:api:hosts");

const DEFAULT_SOFTWARE_BASE_URL = "https://software.cocalc.ai/software";
const SOFTWARE_HISTORY_MAX_LIMIT = 50;
const SOFTWARE_HISTORY_DEFAULT_LIMIT = 1;
const SOFTWARE_FETCH_TIMEOUT_MS = 8_000;
const HOST_UPGRADE_LRO_KIND = "host-upgrade-software";
const HOST_ROLLOUT_MANAGED_COMPONENTS_LRO_KIND =
  "host-rollout-managed-components";
const PROJECT_HOST_RUNTIME_STACK_COMPONENTS: ManagedComponentKind[] = [
  "project-host",
  "conat-router",
  "conat-persist",
  "acp-worker",
];

function canonicalizeSoftwareArtifact(
  artifact: HostSoftwareArtifact,
): "project-host" | "project" | "tools" {
  if (artifact === "project-bundle") return "project";
  return artifact;
}

function extractVersionFromSoftwareUrl(
  artifact: "project-host" | "project" | "tools",
  url?: string,
): string | undefined {
  if (!url) return undefined;
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(new RegExp(`/${artifact}/([^/]+)/`));
    return match?.[1];
  } catch {
    return undefined;
  }
}

function normalizeSoftwareOs(value?: string): "linux" | "darwin" {
  const raw = `${value ?? "linux"}`.trim().toLowerCase();
  if (raw === "darwin" || raw === "macos" || raw === "osx") return "darwin";
  return "linux";
}

function normalizeSoftwareArch(value?: string): "amd64" | "arm64" {
  const raw = `${value ?? "amd64"}`.trim().toLowerCase();
  if (raw === "arm64" || raw === "aarch64") return "arm64";
  return "amd64";
}

function normalizeSoftwareChannels(
  channels?: HostSoftwareChannel[],
): HostSoftwareChannel[] {
  const values = (channels ?? ["latest"]).map((channel) =>
    channel === "staging" ? "staging" : "latest",
  );
  return Array.from(new Set(values));
}

function normalizeSoftwareArtifacts(
  artifacts?: HostSoftwareArtifact[],
): HostSoftwareArtifact[] {
  const defaults: HostSoftwareArtifact[] = ["project-host", "project", "tools"];
  if (!artifacts?.length) return defaults;
  const out: HostSoftwareArtifact[] = [];
  for (const artifact of artifacts) {
    if (
      artifact === "project-host" ||
      artifact === "project" ||
      artifact === "project-bundle" ||
      artifact === "tools"
    ) {
      out.push(artifact);
    }
  }
  return out.length ? Array.from(new Set(out)) : defaults;
}

function normalizeHostUpgradeTargetsForDedupe(
  targets: HostSoftwareUpgradeTarget[],
): Array<{
  artifact: HostSoftwareArtifact;
  channel: HostSoftwareChannel | null;
  version: string | null;
}> {
  return [...(targets ?? [])]
    .map((target) => ({
      artifact: canonicalizeSoftwareArtifact(target.artifact),
      channel: target.version
        ? null
        : ((target.channel === "staging"
            ? "staging"
            : "latest") as HostSoftwareChannel),
      version: target.version?.trim() || null,
    }))
    .sort((a, b) =>
      `${a.artifact}:${a.channel ?? ""}:${a.version ?? ""}`.localeCompare(
        `${b.artifact}:${b.channel ?? ""}:${b.version ?? ""}`,
      ),
    );
}

export function hostUpgradeDedupeKey({
  hostId,
  targets,
  baseUrl,
  alignRuntimeStack,
}: {
  hostId: string;
  targets: HostSoftwareUpgradeTarget[];
  baseUrl?: string;
  alignRuntimeStack?: boolean;
}): string {
  const normalizedBaseUrl = `${baseUrl ?? ""}`.trim() || null;
  return `${HOST_UPGRADE_LRO_KIND}:${hostId}:${JSON.stringify({
    align_runtime_stack: !!alignRuntimeStack,
    base_url: normalizedBaseUrl,
    targets: normalizeHostUpgradeTargetsForDedupe(targets),
  })}`;
}

export function normalizeManagedComponentKindsForDedupe(
  components: ManagedComponentKind[],
): ManagedComponentKind[] {
  return [...new Set(components ?? [])].sort();
}

export function rolloutComponentsForUpgradeResults(
  results: HostSoftwareUpgradeResponse["results"],
  {
    targets,
    alignRuntimeStack = false,
  }: {
    targets?: HostSoftwareUpgradeTarget[];
    alignRuntimeStack?: boolean;
  } = {},
): ManagedComponentKind[] {
  if (
    alignRuntimeStack &&
    (targets ?? []).some((target) => target.artifact === "project-host")
  ) {
    return [...PROJECT_HOST_RUNTIME_STACK_COMPONENTS];
  }
  const components = new Set<ManagedComponentKind>();
  for (const result of results ?? []) {
    if (result.artifact === "project-host" && result.status === "updated") {
      components.add("project-host");
    }
  }
  return [...components];
}

export function hostManagedComponentRolloutDedupeKey({
  hostId,
  components,
  reason,
}: {
  hostId: string;
  components: ManagedComponentKind[];
  reason?: string;
}): string {
  return `${HOST_ROLLOUT_MANAGED_COMPONENTS_LRO_KIND}:${hostId}:${JSON.stringify(
    {
      components: normalizeManagedComponentKindsForDedupe(components),
      reason: `${reason ?? ""}`.trim() || null,
    },
  )}`;
}

function mapPublishedVersionRow({
  artifact,
  channel,
  os,
  arch,
  canonical,
  row,
}: {
  artifact: HostSoftwareArtifact;
  channel: HostSoftwareChannel;
  os: "linux" | "darwin";
  arch: "amd64" | "arm64";
  canonical: "project-host" | "project" | "tools";
  row: any;
}): HostSoftwareAvailableVersion | undefined {
  const url = typeof row?.url === "string" ? row.url : undefined;
  let version = typeof row?.version === "string" ? row.version : undefined;
  if (!version && url) {
    version = extractVersionFromSoftwareUrl(canonical, url);
  }
  const available = !!url;
  if (!available && !version) return undefined;
  return {
    artifact,
    channel,
    os,
    arch,
    version,
    url,
    sha256: typeof row?.sha256 === "string" ? row.sha256 : undefined,
    size_bytes:
      typeof row?.size_bytes === "number" && Number.isFinite(row.size_bytes)
        ? Math.floor(row.size_bytes)
        : undefined,
    built_at: typeof row?.built_at === "string" ? row.built_at : undefined,
    message: typeof row?.message === "string" ? row.message : undefined,
    available,
    error: available ? undefined : "version entry missing url",
  };
}

function normalizePublishedVersionRows(index: any): any[] {
  if (Array.isArray(index?.versions)) {
    return index.versions;
  }
  if (Array.isArray(index)) {
    return index;
  }
  return [];
}

function softwareVersionRowKey({
  version,
  url,
}: {
  version?: string;
  url?: string;
}): string {
  const v = `${version ?? ""}`.trim();
  if (v) return `v:${v}`;
  const u = `${url ?? ""}`.trim();
  if (u) return `u:${u}`;
  return "";
}

async function fetchSoftwareManifest(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOFTWARE_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.json();
}

async function fetchSoftwareManifestMaybe(
  url: string,
): Promise<any | undefined> {
  try {
    return await fetchSoftwareManifest(url);
  } catch {
    return undefined;
  }
}

function softwareVersionsIndexUrl({
  baseUrl,
  artifact,
  channel,
  os,
  arch,
}: {
  baseUrl: string;
  artifact: "project-host" | "project" | "tools";
  channel: HostSoftwareChannel;
  os: "linux" | "darwin";
  arch: "amd64" | "arm64";
}): string {
  if (artifact === "tools") {
    return `${baseUrl}/${artifact}/versions-${channel}-${os}-${arch}.json`;
  }
  return `${baseUrl}/${artifact}/versions-${channel}-${os}.json`;
}

async function resolvePublishedSoftwareRows({
  baseUrl,
  artifact,
  channel,
  os,
  arch,
  limit,
  latest,
}: {
  baseUrl: string;
  artifact: HostSoftwareArtifact;
  channel: HostSoftwareChannel;
  os: "linux" | "darwin";
  arch: "amd64" | "arm64";
  limit: number;
  latest: HostSoftwareAvailableVersion;
}): Promise<HostSoftwareAvailableVersion[]> {
  if (limit <= 1) return [latest];
  const canonical = canonicalizeSoftwareArtifact(artifact);
  const indexUrl = softwareVersionsIndexUrl({
    baseUrl,
    artifact: canonical,
    channel,
    os,
    arch,
  });
  const index = await fetchSoftwareManifestMaybe(indexUrl);
  if (!index) return [latest];
  const rows: HostSoftwareAvailableVersion[] = [latest];
  const seen = new Set<string>();
  const latestKey = softwareVersionRowKey(latest);
  if (latestKey) seen.add(latestKey);
  for (const candidate of normalizePublishedVersionRows(index)) {
    const mapped = mapPublishedVersionRow({
      artifact,
      channel,
      os,
      arch,
      canonical,
      row: candidate,
    });
    if (!mapped) continue;
    const key = softwareVersionRowKey(mapped);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    rows.push(mapped);
    if (rows.length >= limit) break;
  }
  return rows;
}

async function resolveLatestSoftwareRow({
  softwareBaseUrl,
  artifact,
  channel,
  targetOs,
  targetArch,
}: {
  softwareBaseUrl: string;
  artifact: HostSoftwareArtifact;
  channel: HostSoftwareChannel;
  targetOs: "linux" | "darwin";
  targetArch: "amd64" | "arm64";
}): Promise<HostSoftwareAvailableVersion> {
  const canonical = canonicalizeSoftwareArtifact(artifact);
  const manifestUrl =
    canonical === "tools"
      ? `${softwareBaseUrl}/${canonical}/${channel}-${targetOs}-${targetArch}.json`
      : `${softwareBaseUrl}/${canonical}/${channel}-${targetOs}.json`;
  try {
    const manifest = await fetchSoftwareManifest(manifestUrl);
    const resolvedUrl =
      typeof manifest?.url === "string" ? manifest.url : undefined;
    const resolvedVersion = extractVersionFromSoftwareUrl(
      canonical,
      resolvedUrl,
    );
    return {
      artifact,
      channel,
      os: targetOs,
      arch: targetArch,
      version: resolvedVersion,
      url: resolvedUrl,
      sha256:
        typeof manifest?.sha256 === "string" ? manifest.sha256 : undefined,
      size_bytes:
        typeof manifest?.size_bytes === "number" &&
        Number.isFinite(manifest.size_bytes)
          ? Math.floor(manifest.size_bytes)
          : undefined,
      built_at:
        typeof manifest?.built_at === "string" ? manifest.built_at : undefined,
      message:
        typeof manifest?.message === "string" ? manifest.message : undefined,
      available: !!resolvedUrl,
      error: resolvedUrl ? undefined : "manifest missing url",
    };
  } catch (err) {
    return {
      artifact,
      channel,
      os: targetOs,
      arch: targetArch,
      available: false,
      error: `${err instanceof Error ? err.message : err}`,
    };
  }
}

function normalizeSoftwareHistoryLimit(value?: number): number {
  const n = Number(value ?? SOFTWARE_HISTORY_DEFAULT_LIMIT);
  if (!Number.isFinite(n)) return SOFTWARE_HISTORY_DEFAULT_LIMIT;
  return Math.max(1, Math.min(SOFTWARE_HISTORY_MAX_LIMIT, Math.floor(n)));
}

export async function resolveHostSoftwareBaseUrl(
  base_url?: string,
): Promise<string> {
  let requestedBaseUrl = base_url;
  if (requestedBaseUrl) {
    try {
      const parsed = new URL(requestedBaseUrl);
      const host = parsed.hostname.toLowerCase();
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host === "[::1]"
      ) {
        const publicSite = (await siteURL()).replace(/\/+$/, "");
        requestedBaseUrl = `${publicSite}/software`;
      } else {
        const path = parsed.pathname.replace(/\/+$/, "");
        if (!path) {
          parsed.pathname = "/software";
          parsed.search = "";
          parsed.hash = "";
          requestedBaseUrl = parsed.toString();
        }
      }
    } catch {
      // keep provided value as-is if it is not a valid URL
    }
  }
  const { project_hosts_software_base_url } = await getServerSettings();
  const forcedSoftwareBaseUrl =
    process.env.COCALC_PROJECT_HOST_SOFTWARE_BASE_URL_FORCE?.trim() ||
    undefined;
  return (
    requestedBaseUrl ??
    forcedSoftwareBaseUrl ??
    project_hosts_software_base_url ??
    process.env.COCALC_PROJECT_HOST_SOFTWARE_BASE_URL ??
    DEFAULT_SOFTWARE_BASE_URL
  );
}

function isLoopbackHostName(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  );
}

function isLoopbackSoftwareBaseUrl(value: string): boolean {
  try {
    return isLoopbackHostName(new URL(value).hostname);
  } catch {
    return false;
  }
}

function isLocalSelfHost(row: any): boolean {
  const machine: HostMachine = row?.metadata?.machine ?? {};
  if (machine.cloud !== "self-host") return false;
  const mode = machine.metadata?.self_host_mode;
  return !mode || mode === "local";
}

export async function resolveReachableUpgradeBaseUrl({
  row,
  baseUrl,
}: {
  row: any;
  baseUrl: string;
}): Promise<string> {
  if (!isLoopbackSoftwareBaseUrl(baseUrl)) {
    return baseUrl;
  }
  if (isLocalSelfHost(row)) {
    return baseUrl;
  }
  let replacement = DEFAULT_SOFTWARE_BASE_URL;
  try {
    const publicSite = (await siteURL()).replace(/\/+$/, "");
    const candidate = `${publicSite}/software`;
    if (!isLoopbackSoftwareBaseUrl(candidate)) {
      replacement = candidate;
    }
  } catch {
    // keep default replacement
  }
  logger.warn(
    "upgrade host software: replaced loopback base url for remote host",
    {
      host_id: row.id,
      requested: baseUrl,
      effective: replacement,
    },
  );
  return replacement;
}

export async function listHostSoftwareVersions({
  base_url,
  artifacts,
  channels,
  os,
  arch,
  history_limit,
}: {
  base_url?: string;
  artifacts?: HostSoftwareArtifact[];
  channels?: HostSoftwareChannel[];
  os?: "linux" | "darwin";
  arch?: "amd64" | "arm64";
  history_limit?: number;
}): Promise<HostSoftwareAvailableVersion[]> {
  const softwareBaseUrl = (await resolveHostSoftwareBaseUrl(base_url)).replace(
    /\/+$/,
    "",
  );
  const targetOs = normalizeSoftwareOs(os);
  const targetArch = normalizeSoftwareArch(arch);
  const artifactList = normalizeSoftwareArtifacts(artifacts);
  const channelList = normalizeSoftwareChannels(channels);
  const historyLimit = normalizeSoftwareHistoryLimit(history_limit);
  const rows: HostSoftwareAvailableVersion[] = [];
  for (const artifact of artifactList) {
    for (const channel of channelList) {
      const latest = await resolveLatestSoftwareRow({
        softwareBaseUrl,
        artifact,
        channel,
        targetOs,
        targetArch,
      });
      if (!latest.available) {
        rows.push(latest);
        continue;
      }
      const resolved = await resolvePublishedSoftwareRows({
        baseUrl: softwareBaseUrl,
        artifact,
        channel,
        os: targetOs,
        arch: targetArch,
        limit: historyLimit,
        latest,
      });
      rows.push(...resolved);
    }
  }
  return rows;
}

export function mapUpgradeArtifact(
  artifact: string,
): "project_host" | "project_bundle" | "tools" | undefined {
  if (artifact === "project-host") return "project_host";
  if (artifact === "project" || artifact === "project-bundle") {
    return "project_bundle";
  }
  if (artifact === "tools") return "tools";
  return undefined;
}
