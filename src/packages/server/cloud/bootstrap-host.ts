/*
 * Project-host bootstrap lifecycle (cloud-init only)
 *
 * Overview:
 * - Cloud-init/startup-script runs once at first boot using a short-lived
 *   bootstrap token to fetch a larger script from the hub.
 * - The bootstrap script prepares the host, writes logs, and never re-runs
 *   after a successful bootstrap (guarded by /btrfs/data/.bootstrap_done and
 *   /var/lib/cocalc/.bootstrap_done).
 *
 * What bootstrap does:
 * - Disables unattended upgrades during bootstrap (prevents apt locks), then
 *   reinstalls/enables them at the end.
 * - Installs required packages (podman, btrfs, uidmap, slirp4netns,
 *   fuse-overlayfs, rsync, crun, cron, chrony, etc.).
 * - For GPU hosts: installs nvidia-container-toolkit and generates CDI config.
 * - Enables time sync via chrony.
 * - Detects public IP when needed (if public_ip is not known at provision).
 * - Ensures subuid/subgid ranges for the ssh user to allow rootless podman.
 * - Prepares /btrfs:
 *   - Uses an attached data disk when available, otherwise creates a loopback
 *     image at /var/lib/cocalc/btrfs.img.
 *   - Never re-formats an existing btrfs data disk.
 *   - Mounts /btrfs and creates /btrfs/data subvolume.
 * - Configures podman storage to live on /btrfs (via storage.conf).
 * - Writes /etc/cocalc/project-host.env with runtime config.
 * - Fetches and installs:
 *   - project-host bundle
 *   - project bundle
 *   - tools bundle
 * - Writes helper scripts in ~/cocalc-host/bootstrap (ctl/logs/logs-cf, etc.).
 * - Installs /usr/local/sbin/cocalc-grow-btrfs and runs it on boot.
 * - Sets cron @reboot hook to start project-host without re-running bootstrap.
 * - Installs and enables cloudflared (if Cloudflare tunnel is enabled).
 *
 * Notes:
 * - there is no SSH bootstrap; cloud-init/startup-script is the only path.
 * - cloudflared runs under systemd and restarts on reboot.
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { buildHostSpec } from "./host-util";
import { normalizeProviderId } from "@cocalc/cloud";
import type { HostMachine } from "@cocalc/conat/hub/api/hosts";
import type { HostRuntime } from "@cocalc/cloud/types";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getLaunchpadLocalConfig } from "@cocalc/server/launchpad/mode";
import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import { getServerProvider } from "./providers";
import {
  ensureCloudflareTunnelForHost,
  type CloudflareTunnel,
} from "./cloudflare-tunnel";
import { machineHasGpu } from "./host-gpu";
import { getHostSshPublicKeys } from "./ssh-key";

const logger = getLogger("server:cloud:bootstrap-host");
const pool = () => getPool("medium");

type HostBootstrapState = {
  status?: "pending" | "running" | "done";
  started_at?: string;
  finished_at?: string;
  pending_at?: string;
};

type HostMetadata = {
  machine?: HostMachine;
  runtime?: HostRuntime;
  bootstrap?: HostBootstrapState;
  cloudflare_tunnel?: CloudflareTunnel;
  [key: string]: any;
};

type ProjectHostRow = {
  id: string;
  name?: string;
  region?: string;
  public_url?: string;
  internal_url?: string;
  ssh_server?: string;
  status?: string;
  metadata?: HostMetadata;
};

const DEFAULT_SOFTWARE_BASE_URL = "https://software.cocalc.ai/software";

function normalizeSoftwareBaseUrl(raw: string): string {
  const trimmed = (raw || "").trim();
  const base = trimmed || DEFAULT_SOFTWARE_BASE_URL;
  return base.replace(/\/+$/, "");
}

type SoftwareArch = "amd64" | "arm64";
type SoftwareOs = "linux" | "darwin";

function normalizeArch(raw?: string): SoftwareArch | undefined {
  if (!raw) return undefined;
  const value = raw.toLowerCase();
  if (value === "amd64" || value === "x86_64" || value === "x64")
    return "amd64";
  if (value === "arm64" || value === "aarch64") return "arm64";
  return undefined;
}

function normalizeOs(raw?: string): SoftwareOs | undefined {
  if (!raw) return undefined;
  const value = raw.toLowerCase();
  if (value === "linux") return "linux";
  if (value === "darwin" || value === "macos" || value === "osx")
    return "darwin";
  return undefined;
}

async function resolveSelfHostArch(connectorId: string): Promise<{
  arch?: SoftwareArch;
  os?: SoftwareOs;
}> {
  const { rows } = await pool().query<{
    metadata: Record<string, any>;
  }>(
    `SELECT metadata
       FROM self_host_connectors
      WHERE connector_id=$1 AND revoked IS NOT TRUE`,
    [connectorId],
  );
  const metadata = rows[0]?.metadata ?? {};
  return {
    arch: normalizeArch(metadata.arch),
    os: normalizeOs(metadata.os),
  };
}

async function resolveTargetPlatform({
  providerId,
  row,
  runtime,
  machine,
}: {
  providerId?: string;
  row: ProjectHostRow;
  runtime?: HostRuntime;
  machine: HostMachine;
}): Promise<{ os: SoftwareOs; arch: SoftwareArch; source: string }> {
  const fromMetadata = normalizeArch(
    runtime?.metadata?.arch ??
      runtime?.metadata?.architecture ??
      machine.metadata?.arch ??
      machine.metadata?.architecture,
  );
  if (fromMetadata) {
    return { os: "linux", arch: fromMetadata, source: "metadata" };
  }
  if (providerId === "self-host" && row.region) {
    const connectorInfo = await resolveSelfHostArch(row.region);
    if (connectorInfo.arch) {
      return {
        os: "linux",
        arch: connectorInfo.arch,
        source: "self-host-connector",
      };
    }
  }
  return { os: "linux", arch: "amd64", source: "default" };
}

function resolveBootstrapSelector({
  metadata,
  settings,
}: {
  metadata: HostMetadata;
  settings: {
    project_hosts_bootstrap_channel?: string;
    project_hosts_bootstrap_version?: string;
  };
}): { selector: string; source: string } {
  const metaChannel =
    typeof metadata.bootstrap_channel === "string"
      ? metadata.bootstrap_channel.trim()
      : "";
  const metaVersion =
    typeof metadata.bootstrap_version === "string"
      ? metadata.bootstrap_version.trim()
      : "";
  const settingsChannel = settings.project_hosts_bootstrap_channel?.trim() || "";
  const settingsVersion = settings.project_hosts_bootstrap_version?.trim() || "";
  if (metaVersion) return { selector: metaVersion, source: "host-version" };
  if (metaChannel) return { selector: metaChannel, source: "host-channel" };
  if (settingsVersion)
    return { selector: settingsVersion, source: "site-version" };
  if (settingsChannel)
    return { selector: settingsChannel, source: "site-channel" };
  return { selector: "latest", source: "default" };
}

function extractArtifactVersion(
  url: string,
  artifact: "project-host" | "project" | "tools",
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

export type BootstrapScripts = {
  expectedOs: string;
  expectedArch: string;
  bootstrapPyUrl: string;
  bootstrapPyShaUrl: string;
  publicUrl: string;
  internalUrl: string;
  sshServer: string;
  bootstrapUser: string;
  runtimeUser: string;
  hasGpu: boolean;
  imageSizeGb: string;
  dataDiskDevices: string;
  dataDiskCandidates: string;
  envFile: string;
  envLines: string[];
  nodeVersion: string;
  projectHostBundleUrl: string;
  projectHostBundleSha256: string;
  projectHostBundleRemote: string;
  projectHostBundleDir: string;
  projectHostBundlesRoot: string;
  projectHostCurrent: string;
  projectHostBin: string;
  projectHostVersion: string;
  projectBundleUrl: string;
  projectBundleSha256: string;
  projectBundlesRoot: string;
  projectBundleDir: string;
  projectBundleRemote: string;
  projectBundleVersion: string;
  toolsUrl: string;
  toolsSha256: string;
  toolsRoot: string;
  toolsDir: string;
  toolsRemote: string;
  toolsVersion: string;
  tunnel?: CloudflareTunnel;
  cloudflaredConfig?: {
    enabled: boolean;
    hostname?: string;
    port?: number;
    token?: string;
    tunnelId?: string;
    credsJson?: string;
  };
};

export async function buildBootstrapScripts(
  row: ProjectHostRow,
  opts: {
    tunnel?: CloudflareTunnel;
    conatPasswordCommand?: string;
    publicIpOverride?: string;
    launchpadBaseUrl?: string;
  } = {},
): Promise<BootstrapScripts> {
  const runtime = row.metadata?.runtime;
  const metadata = row.metadata ?? {};
  const machine: HostMachine = metadata.machine ?? {};
  const providerId = normalizeProviderId(machine.cloud);
  const isSelfHost = providerId === "self-host";
  const hasGpu = machineHasGpu(machine);
  const selfHostKind = machine.metadata?.self_host_kind;
  const isSelfHostDirect = isSelfHost && selfHostKind === "direct";
  const bootstrapUser = isSelfHostDirect
    ? "\${BOOTSTRAP_USER}"
    : runtime?.ssh_user ?? machine.metadata?.ssh_user ?? "ubuntu";
  const runtimeUser = isSelfHostDirect
    ? bootstrapUser
    : `${process.env.COCALC_PROJECT_HOST_RUNTIME_USER || "cocalc-host"}`.trim() ||
      "cocalc-host";
  const rawSelfHostMode = machine.metadata?.self_host_mode;
  const effectiveSelfHostMode =
    isSelfHost && (!rawSelfHostMode || rawSelfHostMode === "local")
      ? "local"
      : rawSelfHostMode;
  const useOnPremSettings = isSelfHost && effectiveSelfHostMode === "local";
  const publicIp = opts.publicIpOverride ?? runtime?.public_ip ?? "";
  if (!publicIp && !useOnPremSettings) {
    throw new Error("bootstrap requires public_ip");
  }

  const {
    project_hosts_software_base_url,
    project_hosts_bootstrap_channel,
    project_hosts_bootstrap_version,
  } = await getServerSettings();
  const softwareBaseUrl = normalizeSoftwareBaseUrl(
    project_hosts_software_base_url ||
      process.env.COCALC_PROJECT_HOST_SOFTWARE_BASE_URL ||
      "",
  );
  if (!softwareBaseUrl) {
    throw new Error("project host software base URL is not configured");
  }
  const targetPlatform = await resolveTargetPlatform({
    providerId,
    row,
    runtime,
    machine,
  });
  const projectHostManifestUrl = `${softwareBaseUrl}/project-host/latest-${targetPlatform.os}.json`;
  const projectManifestUrl = `${softwareBaseUrl}/project/latest-${targetPlatform.os}.json`;
  const toolsManifestUrl = `${softwareBaseUrl}/tools/latest-${targetPlatform.os}-${targetPlatform.arch}.json`;
  const resolvedHostBundle = await resolveSoftwareArtifact(
    projectHostManifestUrl,
    { os: targetPlatform.os },
  );
  const projectHostBundleUrl = resolvedHostBundle.url;
  const projectHostBundleSha256 = (resolvedHostBundle.sha256 ?? "").replace(
    /[^a-f0-9]/gi,
    "",
  );
  const resolvedProjectBundle = await resolveSoftwareArtifact(
    projectManifestUrl,
    { os: targetPlatform.os },
  );
  const projectBundleUrl = resolvedProjectBundle.url;
  const projectBundleSha256 = (resolvedProjectBundle.sha256 ?? "").replace(
    /[^a-f0-9]/gi,
    "",
  );
  const resolvedTools = await resolveSoftwareArtifact(
    toolsManifestUrl,
    targetPlatform,
  );
  const toolsUrl = resolvedTools.url;
  const toolsSha256 = (resolvedTools.sha256 ?? "").replace(/[^a-f0-9]/gi, "");
  const { selector: bootstrapSelector } = resolveBootstrapSelector({
    metadata,
    settings: {
      project_hosts_bootstrap_channel,
      project_hosts_bootstrap_version,
    },
  });
  const bootstrapPyUrl = `${softwareBaseUrl}/bootstrap/${bootstrapSelector}/bootstrap.py`;
  const bootstrapPyShaUrl = `${bootstrapPyUrl}.sha256`;
  const projectBundleVersion =
    extractArtifactVersion(projectBundleUrl, "project") || "latest";
  const bootstrapHome = isSelfHostDirect
    ? "${BOOTSTRAP_HOME}"
    : bootstrapUser === "root"
      ? "/root"
      : `/home/${bootstrapUser}`;
  const bootstrapRoot = `${bootstrapHome}/cocalc-host`;
  const projectBundlesRoot = "/opt/cocalc/project-bundles";
  const projectBundleDir = `${projectBundlesRoot}/${projectBundleVersion}`;
  const projectBundleRemote = `${bootstrapRoot}/tmp/project-bundle.tar.xz`;
  const projectHostVersion =
    extractArtifactVersion(projectHostBundleUrl, "project-host") || "latest";
  const projectHostBundleRemote = `${bootstrapRoot}/tmp/project-host-bundle.tar.xz`;
  const toolsVersion = extractArtifactVersion(toolsUrl, "tools") || "latest";
  const toolsRoot = "/opt/cocalc/tools";
  const toolsDir = `${toolsRoot}/${toolsVersion}`;
  const toolsRemote = `${bootstrapRoot}/tmp/tools.tar.xz`;
  const nodeVersion = process.env.COCALC_PROJECT_HOST_NODE_VERSION || "24";
  if (!projectHostBundleUrl) {
    throw new Error("project host bundle URL could not be resolved");
  }
  if (!projectBundleUrl) {
    throw new Error("project bundle URL could not be resolved");
  }
  if (!toolsUrl) {
    throw new Error("project tools URL could not be resolved");
  }

  const localConfig = useOnPremSettings
    ? getLaunchpadLocalConfig("local")
    : undefined;
  const localConat =
    localConfig?.http_port ? `http://127.0.0.1:${localConfig.http_port}` : "";
  const launchpadConat = useOnPremSettings
    ? localConat
    : opts.launchpadBaseUrl ?? "";
  const masterAddress =
    process.env.MASTER_CONAT_SERVER ??
    process.env.COCALC_MASTER_CONAT_SERVER ??
    launchpadConat;
  if (!masterAddress) {
    throw new Error("MASTER_CONAT_SERVER is not configured");
  }

  const tunnel = useOnPremSettings
    ? undefined
    : opts.tunnel ??
      (await ensureCloudflareTunnelForHost({
        host_id: row.id,
        existing: metadata.cloudflare_tunnel,
      }));
  const tunnelEnabled = !!tunnel;

  const spec = await buildHostSpec(row);
  const storageMode = machine.storage_mode ?? machine.metadata?.storage_mode;
  const provider = providerId ? getServerProvider(providerId) : undefined;
  const dataDiskDevices =
    provider?.getBootstrapDataDiskDevices?.(spec, storageMode) ?? "";
  const imageSizeGb = isSelfHost
    ? "auto"
    : String(Math.max(20, Number(spec.disk_gb ?? 100)));
  const onPremPortRaw = process.env.COCALC_PROJECT_HOST_PORT ?? "";
  const onPremPort = Number.isFinite(Number.parseInt(onPremPortRaw, 10))
    ? Number.parseInt(onPremPortRaw, 10)
    : 9002;
  const onPremBindHost = process.env.COCALC_PROJECT_HOST_BIND ?? "0.0.0.0";
  const onPremUrlHost =
    onPremBindHost === "0.0.0.0" ? "127.0.0.1" : onPremBindHost;
  const port = useOnPremSettings ? onPremPort : tunnelEnabled ? 9002 : 443;
  const sshPort = 2222;
  const publicUrl = useOnPremSettings
    ? `http://${onPremUrlHost}:${port}`
    : tunnel?.hostname
      ? `https://${tunnel.hostname}`
      : row.public_url
        ? row.public_url.replace(/^http:\/\//, "https://")
        : `https://${publicIp || onPremUrlHost}`;
  const internalUrl = useOnPremSettings
    ? `http://${onPremUrlHost}:${port}`
    : tunnel?.hostname
      ? `https://${tunnel.hostname}`
      : row.internal_url
        ? row.internal_url.replace(/^http:\/\//, "https://")
        : `https://${publicIp || onPremUrlHost}`;
  const sshServer = row.ssh_server ?? `${publicIp || onPremUrlHost}:${sshPort}`;
  const dataDir = "/btrfs/data";
  const envFile = "/etc/cocalc/project-host.env";
  const dataDiskCandidates = dataDiskDevices || "none";
  let tlsHostname = publicIp || onPremUrlHost;
  const tlsEnabled = useOnPremSettings ? false : !tunnelEnabled;
  if (!publicUrl.includes("$")) {
    try {
      tlsHostname = new URL(publicUrl).hostname || publicIp || onPremUrlHost;
    } catch {
      tlsHostname = publicIp || onPremUrlHost;
    }
  }

  const projectHostRoot = "/opt/cocalc/project-host";
  const projectHostBundlesRoot = `${projectHostRoot}/bundles`;
  const projectHostBundleDir = `${projectHostBundlesRoot}/${projectHostVersion}`;
  const projectHostCurrent = `${projectHostRoot}/current`;
  const projectHostBin = `${projectHostRoot}/bin/project-host`;

  const bindHost = useOnPremSettings ? onPremBindHost : "0.0.0.0";
  const isLoopbackBindHost =
    bindHost === "localhost" ||
    bindHost === "::1" ||
    bindHost.startsWith("127.");

  const envLines = [
    `MASTER_CONAT_SERVER=${masterAddress}`,
    `PROJECT_HOST_ID=${row.id}`,
    `PROJECT_HOST_NAME=${row.name ?? row.id}`,
    `PROJECT_HOST_REGION=${row.region ?? ""}`,
    `PROJECT_HOST_PUBLIC_URL=${publicUrl}`,
    `PROJECT_HOST_INTERNAL_URL=${internalUrl}`,
    `PROJECT_HOST_SSH_SERVER=${sshServer}`,
    `PROJECT_RUNNER_NAME=0`,
    `COCALC_FILE_SERVER_MOUNTPOINT=/btrfs`,
    `DATA=${dataDir}`,
    `COCALC_DATA=${dataDir}`,
    `COCALC_LITE_SQLITE_FILENAME=${dataDir}/sqlite.db`,
    `COCALC_PROJECT_BUNDLES=${projectBundlesRoot}`,
    `COCALC_PROJECT_TOOLS=${toolsRoot}/current`,
    `COCALC_BIN_PATH=${toolsRoot}/current`,
    `COCALC_SYNC_PROJECTS=/btrfs/project-[project_id]/.local/share/cocalc/persist`,
    `COCALC_BTRFS_IMAGE_GB=${imageSizeGb}`,
    `COCALC_PROJECT_HOST_SOFTWARE_BASE_URL=${softwareBaseUrl}`,
    `COCALC_PROJECT_HOST_BUNDLE_ROOT=${projectHostBundlesRoot}`,
    `COCALC_PROJECT_HOST_CURRENT=${projectHostCurrent}`,
    `COCALC_PROJECT_HOST_BIN=${projectHostBin}`,
    `COCALC_PROJECT_HOST_RUNTIME_USER=${runtimeUser}`,
    `TMPDIR=/btrfs/data/tmp`,
    `TMP=/btrfs/data/tmp`,
    `TEMP=/btrfs/data/tmp`,
    `COCALC_PROJECT_HOST_HTTPS=${tlsEnabled ? "1" : "0"}`,
    `HOST=${bindHost}`,
    `PORT=${port}`,
    `DEBUG=cocalc:*`,
    `DEBUG_CONSOLE=yes`,
    `COCALC_SSH_SERVER=0.0.0.0:${sshPort}`,
  ];
  if (!isLoopbackBindHost) {
    // Current project-host cloud bootstrap defaults to non-loopback binding.
    // Keep startup explicit and deterministic under network policy guard.
    envLines.push(`COCALC_ALLOW_INSECURE_HTTP_MODE=true`);
  }
  if (isSelfHost) {
    envLines.push(`COCALC_SELF_HOST_MODE=${effectiveSelfHostMode ?? "local"}`);
  }
  if (tlsEnabled) {
    envLines.push(`COCALC_PROJECT_HOST_HTTPS_HOSTNAME=${tlsHostname}`);
  }

  const cloudflaredConfig: BootstrapScripts["cloudflaredConfig"] = (() => {
    if (tunnel && tunnelEnabled) {
      const useToken = Boolean(tunnel.token);
      if (!useToken) {
        logger.warn("cloudflare tunnel token missing; using credentials file", {
          host_id: row.id,
          tunnel_id: tunnel.id,
        });
      }
      const creds = JSON.stringify({
        AccountTag: tunnel.account_id,
        TunnelID: tunnel.id,
        TunnelName: tunnel.name,
        TunnelSecret: tunnel.tunnel_secret,
      });
      return {
        enabled: true,
        hostname: tunnel.hostname,
        port,
        token: useToken ? tunnel.token : undefined,
        tunnelId: tunnel.id,
        credsJson: useToken ? undefined : creds,
      };
    }
    return { enabled: false };
  })();

  return {
    expectedOs: targetPlatform.os,
    expectedArch: targetPlatform.arch,
    bootstrapPyUrl,
    bootstrapPyShaUrl,
    publicUrl,
    internalUrl,
    sshServer,
    bootstrapUser,
    runtimeUser,
    hasGpu,
    imageSizeGb,
    dataDiskDevices,
    dataDiskCandidates,
    envFile,
    envLines,
    nodeVersion,
    projectHostBundleUrl,
    projectHostBundleSha256,
    projectHostBundleRemote,
    projectHostBundleDir,
    projectHostBundlesRoot,
    projectHostCurrent,
    projectHostBin,
    projectHostVersion,
    projectBundleUrl,
    projectBundleSha256,
    projectBundlesRoot,
    projectBundleDir,
    projectBundleRemote,
    projectBundleVersion,
    toolsUrl,
    toolsSha256,
    toolsRoot,
    toolsDir,
    toolsRemote,
    toolsVersion,
    tunnel,
    cloudflaredConfig,
  };
}

export async function buildBootstrapScriptWithStatus(
  row: ProjectHostRow,
  token: string,
  baseUrl: string,
  caCert?: string,
): Promise<string> {
  const statusUrl = `${baseUrl}/project-host/bootstrap/status`;
  const conatUrl = `${baseUrl}/project-host/bootstrap/conat`;
  const caCertBlock = caCert
    ? `BOOTSTRAP_CACERT_PATH="/tmp/cocalc-bootstrap-ca.pem"
cat <<'EOF_COCALC_BOOTSTRAP_CA' > "$BOOTSTRAP_CACERT_PATH"
${caCert}
EOF_COCALC_BOOTSTRAP_CA
CURL_CACERT_ARG="--cacert $BOOTSTRAP_CACERT_PATH"
`
    : `BOOTSTRAP_CACERT_PATH=""
CURL_CACERT_ARG=""`;
  const conatPasswordCommand = `
if [ -f /btrfs/data/secrets/master-conat-token ]; then
  echo "bootstrap: master conat token already present"
else
  echo "bootstrap: fetching master conat token"
  curl -fsSL $CURL_CACERT_ARG -H "Authorization: Bearer $BOOTSTRAP_TOKEN" "$CONAT_URL" | sudo tee /btrfs/data/secrets/master-conat-token >/dev/null
  sudo chmod 600 /btrfs/data/secrets/master-conat-token
fi
`;
  const scripts = await buildBootstrapScripts(row, {
    conatPasswordCommand,
    publicIpOverride: "$PUBLIC_IP",
    launchpadBaseUrl: baseUrl,
  });
  if (!scripts.projectHostBundleUrl) {
    throw new Error("project host bundle URL not configured");
  }
  const aptPackagesJson = JSON.stringify([
    "podman",
    "btrfs-progs",
    "uidmap",
    "slirp4netns",
    "passt",
    "catatonit",
    "fuse-overlayfs",
    "curl",
    "xz-utils",
    "rsync",
    "vim",
    "crun",
    "cron",
    "chrony",
  ]);
  const envLinesJson = JSON.stringify(scripts.envLines);
  const cloudflaredJson = JSON.stringify(scripts.cloudflaredConfig ?? { enabled: false });
  const preferredBootstrapUser =
    scripts.bootstrapUser && scripts.bootstrapUser !== "root"
      ? scripts.bootstrapUser
      : "";
  return `#!/bin/bash
set -euo pipefail
BOOTSTRAP_TOKEN="${token}"
STATUS_URL="${statusUrl}"
CONAT_URL="${conatUrl}"
BOOTSTRAP_USER="\${SUDO_USER:-}"
PREFERRED_BOOTSTRAP_USER="${preferredBootstrapUser}"
if [ -z "$BOOTSTRAP_USER" ]; then
  BOOTSTRAP_USER="$(id -un 2>/dev/null || true)"
fi
if [ -z "$BOOTSTRAP_USER" ]; then
  BOOTSTRAP_USER="root"
fi
if [ -n "$PREFERRED_BOOTSTRAP_USER" ] && [ "$BOOTSTRAP_USER" = "root" ]; then
  BOOTSTRAP_USER="$PREFERRED_BOOTSTRAP_USER"
fi
BOOTSTRAP_HOME="$(getent passwd "$BOOTSTRAP_USER" | cut -d: -f6 || true)"
if [ -z "$BOOTSTRAP_HOME" ] && [ -n "$HOME" ]; then
  BOOTSTRAP_HOME="$HOME"
fi
if [ -z "$BOOTSTRAP_HOME" ]; then
  BOOTSTRAP_HOME="/root"
fi
BOOTSTRAP_DIR="$BOOTSTRAP_HOME/cocalc-host/bootstrap"
BOOTSTRAP_PY_URL="${scripts.bootstrapPyUrl}"
BOOTSTRAP_PY_SHA_URL="${scripts.bootstrapPyShaUrl}"
BOOTSTRAP_PY_FALLBACK_URL="${baseUrl}/project-host/bootstrap.py"
${caCertBlock}
if [ -z "\${PUBLIC_IP+x}" ]; then
  PUBLIC_IP='$PUBLIC_IP'
fi

report_status() {
  local status="$1"
  local message="\${2:-}"
  local payload
  json_escape() {
    local s="\$1"
    s="\${s//\\\\/\\\\\\\\}"
    s="\${s//\"/\\\\\"}"
    s="\${s//$'\\n'/\\\\n}"
    s="\${s//$'\\r'/\\\\r}"
    s="\${s//$'\\t'/\\\\t}"
    printf '%s' "\$s"
  }
  if [ -n "$message" ]; then
    local esc
    esc="$(json_escape "$message")"
    printf -v payload '{"status":"%s","message":"%s"}' "$status" "$esc"
  else
    printf -v payload '{"status":"%s"}' "$status"
  fi
  curl -fsSL $CURL_CACERT_ARG -X POST -H "Authorization: Bearer $BOOTSTRAP_TOKEN" -H "Content-Type: application/json" \
    --data "$payload" \
    "$STATUS_URL" >/dev/null || true
}

bootstrap_log_tail() {
  if [ -f "$BOOTSTRAP_DIR/bootstrap.log" ]; then
    tail -n 80 "$BOOTSTRAP_DIR/bootstrap.log" 2>/dev/null | tr -d '\r'
  fi
}

on_error() {
  local code="$1"
  local line="$2"
  report_status "error" "bootstrap failed (exit \${code}) at line \${line}"
}
trap 'on_error "$?" "$LINENO"' ERR

BOOTSTRAP_ROOT="$BOOTSTRAP_HOME/cocalc-host"
BOOTSTRAP_TMP="$BOOTSTRAP_ROOT/tmp"

mkdir -p "$BOOTSTRAP_DIR"

cat <<EOF_COCALC_BOOTSTRAP_CONFIG > "$BOOTSTRAP_DIR/bootstrap-config.json"
{
  "bootstrap_user": "$BOOTSTRAP_USER",
  "bootstrap_home": "$BOOTSTRAP_HOME",
  "bootstrap_root": "$BOOTSTRAP_ROOT",
  "bootstrap_dir": "$BOOTSTRAP_DIR",
  "bootstrap_tmp": "$BOOTSTRAP_TMP",
  "log_file": "$BOOTSTRAP_DIR/bootstrap.log",
  "expected_os": "${scripts.expectedOs}",
  "expected_arch": "${scripts.expectedArch}",
  "image_size_gb_raw": "${scripts.imageSizeGb}",
  "data_disk_devices": "${scripts.dataDiskDevices}",
  "data_disk_candidates": "${scripts.dataDiskCandidates}",
  "apt_packages": ${aptPackagesJson},
  "has_gpu": ${scripts.hasGpu ? "true" : "false"},
  "ssh_user": "${scripts.runtimeUser}",
  "env_file": "${scripts.envFile}",
  "env_lines": ${envLinesJson},
  "node_version": "${scripts.nodeVersion}",
  "project_host_bundle": {
    "url": "${scripts.projectHostBundleUrl}",
    "sha256": "${scripts.projectHostBundleSha256}",
    "remote": "${scripts.projectHostBundleRemote}",
    "root": "${scripts.projectHostBundlesRoot}",
    "dir": "${scripts.projectHostBundleDir}",
    "current": "${scripts.projectHostCurrent}",
    "version": "${scripts.projectHostVersion}"
  },
  "project_bundle": {
    "url": "${scripts.projectBundleUrl}",
    "sha256": "${scripts.projectBundleSha256}",
    "remote": "${scripts.projectBundleRemote}",
    "root": "${scripts.projectBundlesRoot}",
    "dir": "${scripts.projectBundleDir}",
    "current": "${scripts.projectBundlesRoot}/current",
    "version": "${scripts.projectBundleVersion}"
  },
  "tools_bundle": {
    "url": "${scripts.toolsUrl}",
    "sha256": "${scripts.toolsSha256}",
    "remote": "${scripts.toolsRemote}",
    "root": "${scripts.toolsRoot}",
    "dir": "${scripts.toolsDir}",
    "current": "${scripts.toolsRoot}/current",
    "version": "${scripts.toolsVersion}"
  },
  "cloudflared": ${cloudflaredJson},
  "conat_url": "$CONAT_URL",
  "bootstrap_token": "$BOOTSTRAP_TOKEN",
  "ca_cert_path": "$BOOTSTRAP_CACERT_PATH",
  "parallel": true,
  "bootstrap_done_paths": ["/btrfs/data/.bootstrap_done", "/var/lib/cocalc/.bootstrap_done"]
}
EOF_COCALC_BOOTSTRAP_CONFIG

download_bootstrap_py() {
  local target="$BOOTSTRAP_DIR/bootstrap.py"
  local sha_target="$BOOTSTRAP_DIR/bootstrap.py.sha256"
  if [ -z "$BOOTSTRAP_PY_URL" ]; then
    return 1
  fi
  if curl -fsSL "$BOOTSTRAP_PY_URL" -o "$target"; then
    if [ -n "$BOOTSTRAP_PY_SHA_URL" ]; then
      if curl -fsSL "$BOOTSTRAP_PY_SHA_URL" -o "$sha_target"; then
        if command -v sha256sum >/dev/null 2>&1; then
          (
            cd "$BOOTSTRAP_DIR"
            sha256sum -c "$(basename "$sha_target")"
          ) || return 1
        fi
      fi
    fi
    chmod 755 "$target" || true
    if [ -n "$BOOTSTRAP_USER" ]; then
      chown "$BOOTSTRAP_USER":"$BOOTSTRAP_USER" "$target" || true
      if [ -f "$sha_target" ]; then
        chown "$BOOTSTRAP_USER":"$BOOTSTRAP_USER" "$sha_target" || true
      fi
    fi
    return 0
  fi
  if [ -n "$BOOTSTRAP_PY_FALLBACK_URL" ]; then
    curl -fsSL $CURL_CACERT_ARG -H "Authorization: Bearer $BOOTSTRAP_TOKEN" "$BOOTSTRAP_PY_FALLBACK_URL" -o "$target" || return 1
    chmod 755 "$target" || true
    if [ -n "$BOOTSTRAP_USER" ]; then
      chown "$BOOTSTRAP_USER":"$BOOTSTRAP_USER" "$target" || true
    fi
    return 0
  fi
  return 1
}

if download_bootstrap_py; then
  echo "bootstrap: downloaded bootstrap.py"
else
  echo "bootstrap: failed to download bootstrap.py"
  report_status "error" "bootstrap.py download failed"
  exit 1
fi

report_status "running"
python3 "$BOOTSTRAP_DIR/bootstrap.py" --config "$BOOTSTRAP_DIR/bootstrap-config.json"
report_status "done"
cat <<'EOF_COCALC_DEPROVISION' > "$BOOTSTRAP_ROOT/bin/deprovision.sh"
#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo bash "$0" "$@"
  fi
  echo "deprovision.sh must be run as root (sudo required)" >&2
  exit 1
fi
force=0
uninstall_connector=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --force) force=1 ;;
    --uninstall-connector) uninstall_connector=1 ;;
    --help)
      echo "Usage: deprovision.sh [--force] [--uninstall-connector]"
      exit 0
      ;;
  esac
  shift
done
if [ "$force" -ne 1 ]; then
  read -r -p "This will delete ALL CoCalc data on this host. Continue? [y/N] " ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "aborted"; exit 1 ;;
  esac
fi
SSH_USER="${scripts.runtimeUser}"
SSH_UID="$(id -u "$SSH_USER" 2>/dev/null || echo "")"
TARGET_HOME="$(getent passwd "$SSH_USER" | cut -d: -f6 || true)"
if [ -z "$TARGET_HOME" ]; then
  TARGET_HOME="$HOME"
fi
if [ -n "$SSH_UID" ]; then
  export XDG_RUNTIME_DIR="/run/user/$SSH_UID"
fi
ids="$(sudo -n -u "$SSH_USER" -H env XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" podman ps -a --filter "label=role=project" -q 2>/dev/null || true)"
if [ -n "$ids" ]; then
  if command -v timeout >/dev/null 2>&1; then
    timeout 30s sudo -n -u "$SSH_USER" -H env XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" podman rm -f -t 0 $ids || true
  else
    sudo -n -u "$SSH_USER" -H env XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" podman rm -f -t 0 $ids || true
  fi
fi
pkill -f /opt/cocalc/bin/node || true
if [ -d /btrfs/data/cache/project-roots ]; then
  for m in /btrfs/data/cache/project-roots/*; do
    [ -d "$m" ] || continue
    umount "$m" || umount -l "$m" || true
  done
fi
if mountpoint -q /btrfs; then
  umount /btrfs || umount -l /btrfs || true
fi
if [ -f /etc/fstab ]; then
  sed -i.bak '/cocalc-btrfs/d' /etc/fstab || true
fi
rm -f /var/lib/cocalc/btrfs.img || true
rm -rf /btrfs || true
rm -rf /var/lib/cocalc /etc/cocalc /opt/cocalc || true
rm -f /usr/local/sbin/cocalc-grow-btrfs /usr/local/sbin/cocalc-nvidia-cdi || true
rm -f /etc/containers/storage.conf || true
if [ "$uninstall_connector" -eq 1 ]; then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now cocalc-self-host-connector.service >/dev/null 2>&1 || true
  fi
  if command -v launchctl >/dev/null 2>&1; then
    launchctl unload "$HOME/Library/LaunchAgents/com.cocalc.self-host-connector.plist" >/dev/null 2>&1 || true
  fi
  rm -rf "$TARGET_HOME/.config/cocalc-connector" || true
  rm -f "$TARGET_HOME/.config/systemd/user/cocalc-self-host-connector.service" || true
  rm -f "$TARGET_HOME/Library/LaunchAgents/com.cocalc.self-host-connector.plist" || true
  if command -v sudo >/dev/null 2>&1; then
    sudo rm -f /usr/local/bin/cocalc-self-host-connector || true
  fi
  rm -rf "$TARGET_HOME/cocalc-host" || true
fi
EOF_COCALC_DEPROVISION
sudo chmod +x "$BOOTSTRAP_ROOT/bin/deprovision.sh"
sudo chown "$BOOTSTRAP_USER":"$BOOTSTRAP_USER" "$BOOTSTRAP_ROOT/bin/deprovision.sh"
SSH_UID=""
RUNTIME_DIR=""
ENV_FILE="/etc/cocalc/project-host.env"
if [ -f "$ENV_FILE" ]; then
  RUNTIME_DIR="$(grep '^COCALC_PODMAN_RUNTIME_DIR=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
fi
if [ -z "$RUNTIME_DIR" ] && [ -n "$BOOTSTRAP_USER" ]; then
  SSH_UID="$(id -u "$BOOTSTRAP_USER" 2>/dev/null || true)"
  if [ -n "$SSH_UID" ]; then
    RUNTIME_DIR="/btrfs/data/tmp/cocalc-podman-runtime-$SSH_UID"
  fi
fi
if [ -n "$RUNTIME_DIR" ]; then
  HOST_DIR="$BOOTSTRAP_HOME/cocalc-host"
  sudo mkdir -p "$HOST_DIR"
  cat <<EOF_COCALC_ENV > "$HOST_DIR/env.sh"
#!/usr/bin/env bash
export XDG_RUNTIME_DIR="$RUNTIME_DIR"
export COCALC_PODMAN_RUNTIME_DIR="$RUNTIME_DIR"
export CONTAINERS_CGROUP_MANAGER="cgroupfs"
EOF_COCALC_ENV
  sudo chmod +x "$HOST_DIR/env.sh"
  sudo chown "$BOOTSTRAP_USER":"$BOOTSTRAP_USER" "$HOST_DIR/env.sh"
fi
cat <<'EOF_COCALC_README' > "$BOOTSTRAP_ROOT/README.md"
CoCalc Project Host (Direct) Layout
===================================

This directory is managed by CoCalc. It contains helper scripts and state for
this host. The most important paths:

bootstrap/
  bootstrap.sh       - main bootstrap script
  bootstrap.log      - output from bootstrap.sh

bin/
  ctl                - start/stop/status helpers for project-host
  logs               - tail /btrfs/data/log
  logs-cf            - cloudflared logs (if enabled)
  deprovision.sh     - full teardown (use --force)

Logs and status:
  - Project-host logs:  tail -n 200 /btrfs/data/log -f
  - Connector logs:     journalctl --user -u cocalc-self-host-connector.service -f
  - Cloudflared logs:   $HOME/cocalc-host/bin/logs-cf

Podman debugging:
  . $HOME/cocalc-host/env.sh

Deprovision:
  sudo $HOME/cocalc-host/bin/deprovision.sh --force

Notes:
  - /btrfs holds project data and snapshots.
  - /etc/cocalc/project-host.env contains runtime settings.
EOF_COCALC_README
sudo chown "$BOOTSTRAP_USER":"$BOOTSTRAP_USER" "$BOOTSTRAP_ROOT/README.md"
`;
}

export async function buildCloudInitStartupScript(
  row: ProjectHostRow,
  token: string,
  baseUrl: string,
  caCert?: string,
): Promise<string> {
  let bootstrapBase = baseUrl;
  let tunnelScript = "";
  const machine: HostMachine = row.metadata?.machine ?? {};
  const sshUser =
    row.metadata?.runtime?.ssh_user ?? machine.metadata?.ssh_user ?? "ubuntu";
  const selfHostMode = machine?.metadata?.self_host_mode;
  const isSelfHostLocal =
    machine?.cloud === "self-host" &&
    (!selfHostMode || selfHostMode === "local");
  if (isSelfHostLocal) {
    const localConfig = getLaunchpadLocalConfig("local");
    const httpPort = localConfig.http_port ?? 9200;
    bootstrapBase = `http://127.0.0.1:${httpPort}`;
  }
  const bootstrapUrl = `${bootstrapBase}/project-host/bootstrap`;
  const statusUrl = `${bootstrapBase}/project-host/bootstrap/status`;
  const sshKeys = await getHostSshPublicKeys();
  const sshKeysBlock = sshKeys.length
    ? `SSH_KEYS="$(cat <<'EOF_COCALC_SSH_KEYS'
${sshKeys.join("\n")}
EOF_COCALC_SSH_KEYS
)"
if [ -n "$SSH_KEYS" ]; then
  install -d -m 700 "$BOOTSTRAP_HOME/.ssh"
  AUTH_KEYS="$BOOTSTRAP_HOME/.ssh/authorized_keys"
  touch "$AUTH_KEYS"
  chmod 600 "$AUTH_KEYS"
  while IFS= read -r key; do
    [ -z "$key" ] && continue
    if ! grep -qxF "$key" "$AUTH_KEYS"; then
      echo "$key" >> "$AUTH_KEYS"
    fi
  done <<< "$SSH_KEYS"
  chown -R "$BOOTSTRAP_USER":"$BOOTSTRAP_USER" "$BOOTSTRAP_HOME/.ssh"
fi
`
    : "";
  const caCertBlock = caCert
    ? `BOOTSTRAP_CACERT_PATH="/tmp/cocalc-bootstrap-ca.pem"
cat <<'EOF_COCALC_BOOTSTRAP_CA' > "$BOOTSTRAP_CACERT_PATH"
${caCert}
EOF_COCALC_BOOTSTRAP_CA
CURL_CACERT_ARG="--cacert $BOOTSTRAP_CACERT_PATH"
`
    : `CURL_CACERT_ARG=""`;
  return `#!/bin/bash
set -euo pipefail
BOOTSTRAP_TOKEN="${token}"
BOOTSTRAP_URL="${bootstrapUrl}"
STATUS_URL="${statusUrl}"
BOOTSTRAP_USER="\${SUDO_USER:-}"
PREFERRED_BOOTSTRAP_USER="${sshUser !== "root" ? sshUser : ""}"
if [ -z "$BOOTSTRAP_USER" ]; then
  BOOTSTRAP_USER="$(id -un 2>/dev/null || true)"
fi
if [ -z "$BOOTSTRAP_USER" ]; then
  BOOTSTRAP_USER="root"
fi
if [ -n "$PREFERRED_BOOTSTRAP_USER" ] && [ "$BOOTSTRAP_USER" = "root" ]; then
  BOOTSTRAP_USER="$PREFERRED_BOOTSTRAP_USER"
fi
BOOTSTRAP_HOME="$(getent passwd "\${BOOTSTRAP_USER:-}" | cut -d: -f6 || true)"
if [ -z "$BOOTSTRAP_HOME" ] && [ -n "$HOME" ]; then
  BOOTSTRAP_HOME="$HOME"
fi
if [ -z "$BOOTSTRAP_HOME" ]; then
  BOOTSTRAP_HOME="/root"
fi
${sshKeysBlock}
BOOTSTRAP_DIR="$BOOTSTRAP_HOME/cocalc-host/bootstrap"
BOOTSTRAP_HOST="$(echo "$BOOTSTRAP_URL" | awk -F/ '{print $3}')"
if [[ "$BOOTSTRAP_HOST" == \\[*\\]* ]]; then
  BOOTSTRAP_HOST="\${BOOTSTRAP_HOST#\\[}"
  BOOTSTRAP_HOST="\${BOOTSTRAP_HOST%%\\]*}"
else
  BOOTSTRAP_HOST="\${BOOTSTRAP_HOST%%:*}"
fi
${caCertBlock}

if [ -f /var/lib/cocalc/.bootstrap_done ] || [ -f /btrfs/data/.bootstrap_done ]; then
  echo "bootstrap: already complete; exiting"
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y curl
fi

mkdir -p "$BOOTSTRAP_DIR"
${tunnelScript}
report_status() {
  local status="$1"
  local message="\${2:-}"
  local payload
  json_escape() {
    local s="\$1"
    s="\${s//\\\\/\\\\\\\\}"
    s="\${s//\"/\\\\\"}"
    s="\${s//$'\\n'/\\\\n}"
    s="\${s//$'\\r'/\\\\r}"
    s="\${s//$'\\t'/\\\\t}"
    printf '%s' "\$s"
  }
  if [ -n "$message" ]; then
    local esc
    esc="$(json_escape "$message")"
    printf -v payload '{"status":"%s","message":"%s"}' "$status" "$esc"
  else
    printf -v payload '{"status":"%s"}' "$status"
  fi
  curl -fsSL $CURL_CACERT_ARG -X POST -H "Authorization: Bearer $BOOTSTRAP_TOKEN" -H "Content-Type: application/json" \
    --data "$payload" \
    "$STATUS_URL" >/dev/null || true
}

download_bootstrap() {
  local attempts=8
  local delay=5
  local i=1
  while [ "$i" -le "$attempts" ]; do
    local http_code
    http_code="$(curl -sS $CURL_CACERT_ARG -w "%{http_code}" -o "$BOOTSTRAP_DIR/bootstrap.sh" -H "Authorization: Bearer $BOOTSTRAP_TOKEN" "$BOOTSTRAP_URL" || true)"
    if [ "$http_code" = "200" ]; then
      return 0
    fi
    if [ "$http_code" = "401" ]; then
      echo "bootstrap: download failed (http $http_code)"
      return 1
    fi
    echo "bootstrap: download failed (http $http_code) attempt $i/$attempts; retrying in \${delay}s"
    sleep "$delay"
    if [ "$delay" -lt 60 ]; then
      delay=$((delay * 2))
    fi
    i=$((i + 1))
  done
  return 1
}

wait_for_dns() {
  if ! command -v getent >/dev/null 2>&1; then
    return 0
  fi
  local attempts=10
  local delay=3
  local i=1
  while [ "$i" -le "$attempts" ]; do
    if getent hosts "$BOOTSTRAP_HOST" >/dev/null 2>&1; then
      return 0
    fi
    echo "bootstrap: waiting for DNS for $BOOTSTRAP_HOST (attempt $i/$attempts)"
    sleep "$delay"
    if [ "$delay" -lt 30 ]; then
      delay=$((delay * 2))
    fi
    i=$((i + 1))
  done
  return 1
}

wait_for_dns || echo "bootstrap: DNS not ready; continuing"
if ! download_bootstrap; then
  report_status "error" "bootstrap download failed"
  exit 1
fi
if ! bash "$BOOTSTRAP_DIR/bootstrap.sh" 2>&1 | tee "$BOOTSTRAP_DIR/bootstrap.log"; then
  tail_msg="$(bootstrap_log_tail)"
  if [ -n "$tail_msg" ]; then
    report_status "error" "bootstrap execution failed; tail: $tail_msg"
  else
    report_status "error" "bootstrap execution failed"
  fi
  exit 1
fi
`;
}

async function fetchJson(url: string, redirects = 3): Promise<any> {
  const target = new URL(url);
  const client = target.protocol === "http:" ? http : https;
  return await new Promise((resolve, reject) => {
    const req = client.request(
      {
        method: "GET",
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: { Accept: "application/json" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", async () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (status >= 300 && status < 400 && res.headers.location) {
            if (redirects <= 0) {
              reject(new Error(`SEA manifest redirect limit exceeded: ${url}`));
              return;
            }
            try {
              resolve(await fetchJson(res.headers.location, redirects - 1));
            } catch (err) {
              reject(err);
            }
            return;
          }
          if (status < 200 || status >= 300) {
            reject(
              new Error(
                `SEA manifest fetch failed (${status}): ${body.slice(0, 200)}`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(
              new Error(`SEA manifest parse failed: ${(err as Error).message}`),
            );
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function resolveSoftwareArtifact(
  seaUrl: string,
  expected?: { os?: SoftwareOs; arch?: SoftwareArch },
): Promise<{
  url: string;
  sha256?: string;
}> {
  if (!seaUrl) return { url: "" };
  if (!seaUrl.endsWith(".json")) return { url: seaUrl };
  const manifest = await fetchJson(seaUrl);
  const manifestOs = normalizeOs(manifest?.os);
  const manifestArch = normalizeArch(manifest?.arch);
  if (expected?.os && manifestOs && manifestOs !== expected.os) {
    throw new Error(
      `SEA manifest OS mismatch: expected ${expected.os}, got ${manifestOs}`,
    );
  }
  if (expected?.arch && manifestArch && manifestArch !== expected.arch) {
    throw new Error(
      `SEA manifest arch mismatch: expected ${expected.arch}, got ${manifestArch}`,
    );
  }
  const url = typeof manifest?.url === "string" ? manifest.url : "";
  const sha256 =
    typeof manifest?.sha256 === "string" ? manifest.sha256 : undefined;
  if (!url) {
    throw new Error("SEA manifest missing url");
  }
  return { url, sha256 };
}

export async function handleBootstrap(row: ProjectHostRow) {
  logger.debug("handleBootstrap", { host_id: row.id });
  logger.info("handleBootstrap: skipped (cloud-init only)", {
    host_id: row.id,
  });
  return;
}
