/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  GcpProvider,
  NebiusProvider,
  type HostRuntime,
  type HostSpec,
} from "@cocalc/cloud";
import { GoogleAuth } from "google-auth-library";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  AddressesClient,
  DisksClient,
  FirewallsClient,
  InstancesClient,
  RegionOperationsClient,
  SubnetworksClient,
  ZoneOperationsClient,
} from "@google-cloud/compute";
import { getProviderContext } from "@cocalc/server/cloud/provider-context";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getNebiusRegionKeys } from "@cocalc/server/cloud/nebius-credentials";
import {
  buildHostSpec,
  getGcpAcceleratorImage,
} from "@cocalc/server/cloud/host-util";
import { getHostOwnerBaySshIdentity } from "@cocalc/server/cloud/ssh-key";
import {
  gcpCpuCountForMachineType,
  gcpMemoryGiBForMachineType,
} from "@cocalc/util/project-host-pricing";
import { getComputeVmConfig, type ComputeVmConfig } from "./config";
import type { ComputeVmRow, ComputeVolumeRow } from "./types";
import { assertComputeVmSecurity } from "./security";
import { regionFromComputeZone } from "./placement";

const gcpProvider = new GcpProvider();
const nebiusProvider = new NebiusProvider();
const execFileAsync = promisify(execFile);
let networkSecurityCheck: { key: string; checked_at: number } | undefined;
let nebiusSecurityGroupCheck:
  | { key: string; checked_at: number; security_group_id: string }
  | undefined;
let subnetInventoryCache:
  | {
      key: string;
      checked_at: number;
      subnets: Map<string, string>;
    }
  | undefined;
const NETWORK_CACHE_MS = 60_000;
const REQUIRED_NON_PUBLIC_IPV4_RANGES = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "199.36.153.4/30",
  "199.36.153.8/30",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

export function isProviderNotFound(err: unknown): boolean {
  return /not found|was not found|code.?5|404/i.test(`${err}`);
}

function requireGcpZone(resource: ComputeVmRow | ComputeVolumeRow): string {
  if (resource.provider !== "gcp") {
    throw new Error(
      `managed compute resource '${resource.id}' is not a GCP resource`,
    );
  }
  if (!resource.zone) {
    throw new Error(
      `managed compute GCP resource '${resource.id}' has no zone`,
    );
  }
  return resource.zone;
}

function gcpClientOptions(config: ComputeVmConfig) {
  if (!config.gcp_service_account_json || !config.gcp_project_id) {
    throw new Error("managed compute GCP credentials are not configured");
  }
  return {
    options: { credentials: JSON.parse(config.gcp_service_account_json) },
    project: config.gcp_project_id,
  };
}

async function waitForRegionalOperation(opts: {
  response: any;
  config: ComputeVmConfig;
  region: string;
}) {
  let operation = opts.response?.latestResponse ?? opts.response;
  if (!operation?.name) return;
  const { options, project } = gcpClientOptions(opts.config);
  const client = new RegionOperationsClient(options);
  while (`${operation.status ?? ""}` !== "DONE") {
    [operation] = await client.wait({
      operation: operation.name,
      project,
      region: opts.region,
    });
  }
  if (operation.error?.errors?.length) {
    throw new Error(
      `GCP regional operation failed: ${JSON.stringify(operation.error.errors)}`,
    );
  }
}

async function waitForZonalOperation(opts: {
  response: any;
  config: ComputeVmConfig;
  zone: string;
}) {
  let operation = opts.response?.latestResponse ?? opts.response;
  if (!operation?.name) return;
  const { options, project } = gcpClientOptions(opts.config);
  const client = new ZoneOperationsClient(options);
  while (`${operation.status ?? ""}` !== "DONE") {
    [operation] = await client.wait({
      operation: operation.name,
      project,
      zone: opts.zone,
    });
  }
  if (operation.error?.errors?.length) {
    throw new Error(
      `GCP zonal operation failed: ${JSON.stringify(operation.error.errors)}`,
    );
  }
}

function includesRanges(rule: any, expected: string[]): boolean {
  const actual = new Set((rule.destinationRanges ?? []).map(String));
  return expected.every((range) => actual.has(range));
}

function hasExactRanges(actualValues: unknown, expected: string[]): boolean {
  const actual = Array.isArray(actualValues)
    ? new Set(actualValues.map(String))
    : new Set<string>();
  return (
    actual.size === expected.length &&
    expected.every((value) => actual.has(value))
  );
}

function hasExactTcpPorts(rule: any, ports: string[]): boolean {
  return (
    Array.isArray(rule.allowed) &&
    rule.allowed.length === 1 &&
    `${rule.allowed[0]?.IPProtocol ?? ""}` === "tcp" &&
    hasExactRanges(rule.allowed[0]?.ports, ports)
  );
}

function allowsProtocol(rule: any, protocol: string, port?: string): boolean {
  return (rule.allowed ?? []).some((entry: any) => {
    if (`${entry.IPProtocol ?? ""}` !== protocol) return false;
    return port == null || (entry.ports ?? []).map(String).includes(port);
  });
}

function deniesAll(rule: any): boolean {
  return (rule.denied ?? []).some(
    (entry: any) => `${entry.IPProtocol ?? ""}` === "all",
  );
}

function normalizeResourceUri(value: unknown): string {
  return `${value ?? ""}`.replace(/^https:\/\/[^/]+\/compute\/v1\//, "");
}

function configuredNetworkName(config: ComputeVmConfig): string | undefined {
  return config.gcp_network?.match(
    /^projects\/[^/]+\/global\/networks\/([^/]+)$/,
  )?.[1];
}

export function regionalComputeSubnetworks(
  config: ComputeVmConfig,
  observed: Array<{ regionPath?: string; subnet: any }>,
): Map<string, string> {
  if (!config.gcp_project_id || !config.gcp_network) {
    throw new Error("managed compute dedicated GCP network is not configured");
  }
  const networkName = configuredNetworkName(config);
  if (!networkName) {
    throw new Error("managed compute GCP network URI is invalid");
  }
  const subnets = new Map<string, string>();
  for (const { regionPath, subnet } of observed) {
    if (normalizeResourceUri(subnet.network) !== config.gcp_network) continue;
    if (subnet.purpose && subnet.purpose !== "PRIVATE") continue;
    const region =
      normalizeResourceUri(subnet.region).split("/").pop() ||
      `${regionPath ?? ""}`.split("/").pop();
    if (!region || subnet.name !== `${networkName}-${region}`) continue;
    if (subnet.enableFlowLogs !== true && subnet.logConfig?.enable !== true) {
      throw new Error(
        `managed compute subnetwork '${subnet.name}' must have VPC Flow Logs enabled`,
      );
    }
    if (subnets.has(region)) {
      throw new Error(
        `managed compute has multiple configured subnetworks in ${region}`,
      );
    }
    subnets.set(
      region,
      `projects/${config.gcp_project_id}/regions/${region}/subnetworks/${subnet.name}`,
    );
  }
  if (!subnets.size) {
    throw new Error(
      `managed compute network '${networkName}' has no flow-log-enabled regional subnetworks`,
    );
  }
  return subnets;
}

async function discoverProviderComputeSubnetworks(
  config: ComputeVmConfig,
): Promise<Map<string, string> | undefined> {
  if (config.staging_legacy_provider) return undefined;
  if (
    !config.gcp_service_account_json ||
    !config.gcp_project_id ||
    !config.gcp_network
  ) {
    throw new Error("managed compute dedicated GCP network is not configured");
  }
  if (!configuredNetworkName(config)) {
    throw new Error("managed compute GCP network URI is invalid");
  }
  const key = `${config.gcp_project_id}:${config.gcp_network}`;
  if (
    subnetInventoryCache?.key === key &&
    Date.now() - subnetInventoryCache.checked_at < NETWORK_CACHE_MS
  ) {
    return new Map(subnetInventoryCache.subnets);
  }
  const client = new SubnetworksClient({
    credentials: JSON.parse(config.gcp_service_account_json),
  });
  const observed: Array<{ regionPath?: string; subnet: any }> = [];
  for await (const [regionPath, scoped] of client.aggregatedListAsync({
    project: config.gcp_project_id,
  })) {
    for (const subnet of scoped.subnetworks ?? []) {
      observed.push({ regionPath, subnet });
    }
  }
  const subnets = regionalComputeSubnetworks(config, observed);
  subnetInventoryCache = { key, checked_at: Date.now(), subnets };
  return new Map(subnets);
}

export async function getProviderComputeRegions(): Promise<
  Set<string> | undefined
> {
  const config = await getComputeVmConfig();
  const subnets = await discoverProviderComputeSubnetworks(config);
  return subnets == null ? undefined : new Set(subnets.keys());
}

export async function requireProviderComputeSubnetwork(
  zone: string,
): Promise<string | undefined> {
  const config = await getComputeVmConfig();
  const subnets = await discoverProviderComputeSubnetworks(config);
  if (subnets == null) return undefined;
  const region = regionFromComputeZone(zone);
  const subnet = subnets.get(region);
  if (!subnet) {
    throw new Error(
      `managed compute has no configured regional subnetwork for zone '${zone}'`,
    );
  }
  return subnet;
}

async function assertProviderComputeNetworkSecurity(config: ComputeVmConfig) {
  if (config.staging_legacy_provider) return;
  if (
    !config.gcp_service_account_json ||
    !config.gcp_project_id ||
    !config.gcp_network
  ) {
    throw new Error("managed compute dedicated GCP network is not configured");
  }
  const key = `${config.gcp_project_id}:${config.gcp_network}:${config.gcp_network_tag}`;
  if (
    networkSecurityCheck?.key === key &&
    Date.now() - networkSecurityCheck.checked_at < 5 * 60_000
  ) {
    return;
  }
  const client = new FirewallsClient({
    credentials: JSON.parse(config.gcp_service_account_json),
  });
  const rules = new Map<string, any>();
  for await (const rule of client.listAsync({
    project: config.gcp_project_id,
  })) {
    if (rule.name) rules.set(rule.name, rule);
  }
  const required = [
    "cocalc-compute-ssh",
    "cocalc-compute-https",
    "cocalc-compute-metadata",
    "cocalc-compute-deny-private",
    "cocalc-compute-public-egress",
  ];
  for (const name of required) {
    const rule = rules.get(name);
    if (!rule || rule.disabled === true) {
      throw new Error(
        `managed compute firewall rule '${name}' is missing or disabled`,
      );
    }
    if (!(rule.targetTags ?? []).includes(config.gcp_network_tag)) {
      throw new Error(
        `managed compute firewall rule '${name}' has the wrong target tag`,
      );
    }
    if (normalizeResourceUri(rule.network) !== config.gcp_network) {
      throw new Error(
        `managed compute firewall rule '${name}' is on the wrong network`,
      );
    }
  }
  const deny = rules.get("cocalc-compute-deny-private");
  const metadata = rules.get("cocalc-compute-metadata");
  const publicEgress = rules.get("cocalc-compute-public-egress");
  if (
    deny.direction !== "EGRESS" ||
    !deniesAll(deny) ||
    !includesRanges(deny, REQUIRED_NON_PUBLIC_IPV4_RANGES)
  ) {
    throw new Error("managed compute private-egress deny rule is invalid");
  }
  if (
    metadata.direction !== "EGRESS" ||
    !allowsProtocol(metadata, "all") ||
    !includesRanges(metadata, ["169.254.169.254/32"])
  ) {
    throw new Error("managed compute metadata egress rule is invalid");
  }
  if (
    publicEgress.direction !== "EGRESS" ||
    !allowsProtocol(publicEgress, "all") ||
    !includesRanges(publicEgress, ["0.0.0.0/0"])
  ) {
    throw new Error("managed compute public-egress rule is invalid");
  }
  if (
    Number(metadata.priority) >= Number(deny.priority) ||
    Number(deny.priority) >= Number(publicEgress.priority)
  ) {
    throw new Error("managed compute egress firewall priorities are invalid");
  }
  const ssh = rules.get("cocalc-compute-ssh");
  if (
    ssh.direction !== "INGRESS" ||
    !hasExactTcpPorts(ssh, ["22"]) ||
    !hasExactRanges(ssh.sourceRanges, ["0.0.0.0/0"])
  ) {
    throw new Error("managed compute SSH ingress rule is invalid");
  }
  const https = rules.get("cocalc-compute-https");
  if (
    https.direction !== "INGRESS" ||
    !hasExactTcpPorts(https, ["443"]) ||
    !hasExactRanges(https.sourceRanges, ["0.0.0.0/0"])
  ) {
    throw new Error("managed compute HTTPS ingress rule is invalid");
  }
  for (const [name, rule] of rules) {
    if (name === "cocalc-compute-ssh" || name === "cocalc-compute-https") {
      continue;
    }
    if (
      rule.direction === "INGRESS" &&
      rule.disabled !== true &&
      (rule.targetTags ?? []).includes(config.gcp_network_tag) &&
      (rule.allowed ?? []).length > 0 &&
      (!rule.sourceRanges?.length || rule.sourceRanges.includes("0.0.0.0/0"))
    ) {
      throw new Error(
        `unexpected public ingress firewall rule '${name}' targets managed compute`,
      );
    }
  }
  networkSecurityCheck = { key, checked_at: Date.now() };
}

function specFor(
  vm: ComputeVmRow,
  config: ComputeVmConfig,
  subnetwork: string | undefined,
  pricingModel = vm.effective_pricing_model,
  volume?: ComputeVolumeRow,
): HostSpec {
  const operatingSystem = vm.operating_system ?? "linux";
  const cpu =
    Number(vm.cpu) ||
    Number(vm.metadata?.machine?.cpu) ||
    (vm.provider === "gcp"
      ? gcpCpuCountForMachineType(vm.machine_type)
      : undefined);
  const ramGb =
    Number(vm.ram_gb) ||
    Number(vm.metadata?.machine?.ram_gb) ||
    (vm.provider === "gcp"
      ? gcpMemoryGiBForMachineType(vm.machine_type)
      : undefined);
  if (!cpu || !ramGb) {
    throw new Error(`missing machine dimensions for '${vm.machine_type}'`);
  }
  return {
    name: vm.metadata?.provider_instance_name ?? vm.provider_instance_id,
    region: vm.region,
    zone: vm.zone ?? undefined,
    pricing_model: pricingModel,
    cpu,
    ram_gb: ramGb,
    disk_gb: 0,
    disk_type: "balanced" as const,
    shared_disk_gb: volume?.effective_size_gb,
    shared_disk_type: volume?.disk_type,
    gpu:
      vm.gpu_type && vm.gpu_count > 0
        ? { type: vm.gpu_type, count: vm.gpu_count }
        : undefined,
    tags: vm.provider === "gcp" ? [config.gcp_network_tag] : undefined,
    metadata: {
      ...vm.provider_spec,
      machine_type: vm.machine_type,
      storage_mode: "boot-only",
      boot_disk_gb: vm.boot_disk_gb,
      boot_disk_name: vm.boot_disk_id,
      boot_disk_provider_id: vm.metadata?.runtime?.diskIds?.boot,
      persistent_boot_disk: true,
      ...(vm.provider === "gcp" && operatingSystem === "windows"
        ? {
            source_image_project: "windows-cloud",
            source_image_family: "windows-2022",
            instance_metadata: {
              "enable-windows-ssh": "TRUE",
              "sysprep-specialize-script-cmd":
                "googet -noconfirm=true install google-compute-engine-ssh",
              "windows-startup-script-ps1": managedWindowsVmBootstrapScript(vm),
            },
          }
        : vm.provider === "gcp"
          ? {
              source_image_project: "ubuntu-os-cloud",
              source_image_family:
                vm.architecture === "arm64"
                  ? "ubuntu-2404-lts-arm64"
                  : "ubuntu-2404-lts-amd64",
            }
          : {
              public_address_id: vm.public_address_id,
              shared_disk_device_id: "home",
            }),
      ssh_user: vm.ssh_user,
      ssh_public_key: vm.ssh_public_key,
      ssh_public_keys: vm.metadata?.ssh_public_keys,
      block_project_ssh_keys: true,
      disable_service_account: true,
      subnetwork_uri: subnetwork,
      public_ip: vm.public_ip,
      labels: {
        "managed-by": "cocalc-compute",
        "logical-vm": vm.id.replaceAll("-", "").slice(0, 40),
        owner: vm.owner_account_id.replaceAll("-", "").slice(0, 40),
        environment: config.environment,
      },
      shared_disk_name: volume?.provider_disk_id,
      shared_disk_id:
        volume?.metadata?.provider?.id ?? volume?.provider_disk_id,
      startup_script:
        operatingSystem === "windows"
          ? undefined
          : managedVmBootstrapScript(vm, volume),
    },
  };
}

async function resolvedSpecFor(
  vm: ComputeVmRow,
  config: ComputeVmConfig,
  subnetwork: string | undefined,
  pricingModel = vm.effective_pricing_model,
  volume?: ComputeVolumeRow,
): Promise<HostSpec> {
  const managed = specFor(vm, config, subnetwork, pricingModel, volume);
  if (vm.provider === "gcp") {
    if (!managed.gpu) return managed;
    const image = await getGcpAcceleratorImage(vm.machine_type, {
      ubuntuVersion: 2404,
    });
    return {
      ...managed,
      metadata: {
        ...(managed.metadata ?? {}),
        source_image_project: image.project,
        source_image_family: image.family,
      },
    };
  }
  const securityGroupId = await ensureNebiusManagedComputeSecurityGroup(
    vm.region,
  );
  const base = await buildHostSpec({
    id: vm.id,
    name: vm.name,
    region: vm.region,
    metadata: {
      machine: {
        cloud: "nebius",
        machine_type: vm.machine_type,
        disk_gb: 0,
        disk_type: "balanced",
        shared_disk_gb: volume?.effective_size_gb,
        shared_disk_type: volume?.disk_type,
        gpu_type: vm.gpu_type ?? undefined,
        gpu_count: vm.gpu_count,
        metadata: {
          ...vm.provider_spec,
          ssh_user: "user",
          architecture: vm.architecture,
        },
      },
      pricing_model: pricingModel,
    },
  });
  return mergeManagedNebiusSpec(base, managed, securityGroupId);
}

export function mergeManagedNebiusSpec(
  base: HostSpec,
  managed: HostSpec,
  securityGroupId: string,
): HostSpec {
  return {
    ...base,
    ...managed,
    metadata: {
      ...(base.metadata ?? {}),
      ...(managed.metadata ?? {}),
      security_group_ids: [securityGroupId],
    },
  };
}

export function managedVmBootstrapScript(
  vm: ComputeVmRow,
  volume?: ComputeVolumeRow,
) {
  const keys = Array.from(
    new Set(
      [
        vm.ssh_public_key,
        ...(Array.isArray(vm.metadata?.ssh_public_keys)
          ? vm.metadata.ssh_public_keys
          : []),
      ]
        .map((key) => `${key ?? ""}`.trim())
        .filter(Boolean),
    ),
  ).join("\n");
  const volumeDevice = volume
    ? vm.provider === "gcp"
      ? `/dev/disk/by-id/google-${volume.provider_disk_id}`
      : "/dev/disk/by-id/virtio-home"
    : undefined;
  const volumeSetup = volume
    ? `device=${volumeDevice}
for _ in $(seq 1 60); do
  test -b "$device" && break
  sleep 1
done
test -b "$device"
new_filesystem=no
if ! blkid "$device" >/dev/null 2>&1; then
  mkfs.ext4 -F -m 0 "$device"
  new_filesystem=yes
fi
mkdir -p /mnt/cocalc-managed-home
mountpoint -q /mnt/cocalc-managed-home || mount "$device" /mnt/cocalc-managed-home
if test "$new_filesystem" = yes; then
  cp -a /etc/skel/. /mnt/cocalc-managed-home/
  chown -R "$user_uid:$user_gid" /mnt/cocalc-managed-home
fi
umount /mnt/cocalc-managed-home
uuid=$(blkid -s UUID -o value "$device")
sed -i '\\|[[:space:]]/home/user[[:space:]]|d' /etc/fstab
echo "UUID=$uuid /home/user ext4 defaults,nofail 0 2" >> /etc/fstab
mountpoint -q /home/user || mount /home/user
rmdir /home/user/lost+found 2>/dev/null || true

cat >/usr/local/sbin/cocalc-grow-home-filesystem <<'EOF'
#!/bin/bash
set -euo pipefail
device=${volumeDevice}
test -b "$device" || exit 0
mountpoint -q /home/user || exit 0
mounted_device=$(findmnt -n -o SOURCE /home/user)
test "$(readlink -f "$mounted_device")" = "$(readlink -f "$device")" || exit 0
block_bytes=$(blockdev --getsize64 "$device")
block_size=$(dumpe2fs -h "$device" 2>/dev/null | awk -F: '/Block size:/{gsub(/ /, "", $2); print $2}')
block_count=$(dumpe2fs -h "$device" 2>/dev/null | awk -F: '/Block count:/{gsub(/ /, "", $2); print $2}')
test -n "$block_size" -a -n "$block_count" || exit 1
filesystem_bytes=$((block_size * block_count))
if test "$filesystem_bytes" -lt "$block_bytes"; then
  resize2fs "$device"
fi
EOF
chmod 0755 /usr/local/sbin/cocalc-grow-home-filesystem

cat >/etc/systemd/system/cocalc-grow-home-filesystem.service <<'EOF'
[Unit]
Description=Grow the CoCalc managed home filesystem
After=local-fs.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/cocalc-grow-home-filesystem
EOF

cat >/etc/systemd/system/cocalc-grow-home-filesystem.timer <<'EOF'
[Unit]
Description=Detect online growth of the CoCalc managed home disk

[Timer]
OnBootSec=15s
OnUnitActiveSec=30s
AccuracySec=5s
Unit=cocalc-grow-home-filesystem.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now cocalc-grow-home-filesystem.timer
systemctl start cocalc-grow-home-filesystem.service
`
    : "";
  return `#!/bin/bash
set -euo pipefail
if ! getent group user >/dev/null; then
  groupadd user
fi
if ! id user >/dev/null 2>&1; then
  useradd --uid 1001 --gid user --create-home --shell /bin/bash user
fi
test "$(id -u user)" = 1001
test "$(id -gn user)" = user
test "$(getent passwd user | cut -d: -f6)" = /home/user
test "$(getent passwd user | cut -d: -f7)" = /bin/bash
user_uid=$(id -u user)
user_gid=$(id -g user)
usermod -aG sudo user
cat >/etc/sudoers.d/cocalc-user <<'EOF'
user ALL=(ALL) NOPASSWD:ALL
EOF
chmod 0440 /etc/sudoers.d/cocalc-user
if id ubuntu >/dev/null 2>&1; then
  userdel --remove ubuntu
fi
! id ubuntu >/dev/null 2>&1

${volumeSetup}
install -d -m 0700 -o user -g user /home/user/.ssh
cat >/home/user/.ssh/authorized_keys <<'COCALC_MANAGED_VM_KEYS'
${keys}
COCALC_MANAGED_VM_KEYS
chown user:user /home/user/.ssh/authorized_keys
chmod 0600 /home/user/.ssh/authorized_keys
install -d -m 0755 /run/cocalc-managed-vm
printf '%s\n' '${vm.bootstrap_revision}' >/run/cocalc-managed-vm/bootstrap-ready
`;
}

export function managedWindowsSshKeysScript(
  values: Array<string | null | undefined>,
): string {
  const keys = Array.from(
    new Set(values.map((key) => `${key ?? ""}`.trim()).filter(Boolean)),
  ).join("\n");
  const encodedKeys = Buffer.from(`${keys}\n`, "utf8").toString("base64");
  return `$userHome = "C:\\Users\\user"
$sshDir = Join-Path $userHome ".ssh"
New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
$keys = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${encodedKeys}"))
[IO.File]::WriteAllText((Join-Path $sshDir "authorized_keys"), $keys, [Text.UTF8Encoding]::new($false))
$principal = "$env:COMPUTERNAME\\user"
& icacls.exe $sshDir /inheritance:r /grant:r ($principal + ":(OI)(CI)F") "SYSTEM:(OI)(CI)F" | Out-Null
& icacls.exe (Join-Path $sshDir "authorized_keys") /inheritance:r /grant:r ($principal + ":F") "SYSTEM:F" | Out-Null`;
}

export function managedWindowsVmBootstrapScript(vm: ComputeVmRow): string {
  const sshKeySetup = managedWindowsSshKeysScript([
    vm.ssh_public_key,
    ...(Array.isArray(vm.metadata?.ssh_public_keys)
      ? vm.metadata.ssh_public_keys
      : []),
  ]);
  return `$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
  $googet = "C:\\Program Files\\Google\\Compute Engine\\package_manager\\googet.exe"
  if (Test-Path $googet) {
    & $googet -noconfirm=true install google-compute-engine-ssh
  }
}
if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
}

$account = Get-LocalUser -Name "user" -ErrorAction SilentlyContinue
if (-not $account) {
  $bootstrapPassword = ConvertTo-SecureString (([guid]::NewGuid().ToString("N")) + "aA1!") -AsPlainText -Force
  $account = New-LocalUser -Name "user" -Password $bootstrapPassword -AccountNeverExpires -PasswordNeverExpires
}
$administrators = Get-LocalGroup -SID "S-1-5-32-544"
$isAdministrator = Get-LocalGroupMember -Group $administrators | Where-Object { $_.SID.Value -eq $account.SID.Value }
if (-not $isAdministrator) {
  Add-LocalGroupMember -Group $administrators -Member $account
}

${sshKeySetup}

$sshdConfig = @'
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthorizedKeysFile .ssh/authorized_keys
AllowUsers user
Subsystem sftp sftp-server.exe
'@
[IO.File]::WriteAllText("C:\\ProgramData\\ssh\\sshd_config", $sshdConfig, [Text.UTF8Encoding]::new($false))
New-Item -Path "HKLM:\\SOFTWARE\\OpenSSH" -Force | Out-Null
New-ItemProperty -Path "HKLM:\\SOFTWARE\\OpenSSH" -Name DefaultShell -Value "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -PropertyType String -Force | Out-Null
Set-Service -Name sshd -StartupType Automatic
Restart-Service sshd
if (-not (Get-NetFirewallRule -Name "CoCalc-Managed-SSH" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name "CoCalc-Managed-SSH" -DisplayName "CoCalc managed SSH" -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow | Out-Null
}
if (-not (Get-NetFirewallRule -Name "CoCalc-Managed-HTTPS" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name "CoCalc-Managed-HTTPS" -DisplayName "CoCalc managed HTTPS" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow | Out-Null
}

Set-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" -Name fDenyTSConnections -Value 0
Enable-NetFirewallRule -DisplayGroup "Remote Desktop" -ErrorAction SilentlyContinue
Set-Service -Name TermService -StartupType Automatic
Start-Service -Name TermService -ErrorAction SilentlyContinue

$readyDir = "C:\\ProgramData\\CoCalc"
New-Item -ItemType Directory -Force -Path $readyDir | Out-Null
[IO.File]::WriteAllText((Join-Path $readyDir "bootstrap-ready.txt"), "${vm.bootstrap_revision}", [Text.UTF8Encoding]::new($false))
`;
}

export function providerInstanceIdIsProvisional(
  vm: Pick<ComputeVmRow, "provider" | "provider_instance_id" | "metadata">,
): boolean {
  const providerInstanceName = vm.metadata?.provider_instance_name;
  return (
    vm.provider === "nebius" &&
    typeof providerInstanceName === "string" &&
    providerInstanceName.length > 0 &&
    vm.provider_instance_id === providerInstanceName
  );
}

function runtimeFor(vm: ComputeVmRow): HostRuntime {
  return {
    provider: vm.provider,
    instance_id: vm.provider_instance_id,
    public_ip: vm.public_ip ?? undefined,
    private_ip: vm.metadata?.runtime?.private_ip,
    internal_hostname: vm.metadata?.runtime?.internal_hostname,
    ssh_user: vm.ssh_user,
    zone: vm.zone ?? vm.region,
    metadata: {
      ...(vm.metadata?.runtime ?? {}),
      boot_disk_name: vm.boot_disk_id,
      persistent_boot_disk: true,
      machine_type: vm.machine_type,
      ssh_public_key: vm.ssh_public_key,
      ssh_public_keys: vm.metadata?.ssh_public_keys,
      ssh_user: vm.ssh_user,
      public_address_id: vm.public_address_id,
      provisional_instance_id: providerInstanceIdIsProvisional(vm),
    },
  };
}

async function context(
  providerId: ComputeVmRow["provider"] | ComputeVolumeRow["provider"] = "gcp",
  region?: string,
) {
  const config = await getComputeVmConfig();
  if (providerId === "nebius") {
    const { creds } = await getProviderContext("nebius", { region });
    return { config, creds };
  }
  if (config.gcp_service_account_json) {
    return {
      config,
      creds: {
        service_account_json: config.gcp_service_account_json,
        prefix: "cocalc-vm",
      },
    };
  }
  if (config.staging_legacy_provider) {
    const { creds } = await getProviderContext("gcp");
    return { config, creds };
  }
  throw new Error(
    "managed compute VM provider credentials are not configured for this environment",
  );
}

async function ensureNebiusManagedComputeSecurityGroup(region: string) {
  const { creds } = await context("nebius", region);
  const securityKey = `${creds.parentId ?? ""}:${creds.subnetId ?? ""}`;
  if (
    !nebiusSecurityGroupCheck ||
    nebiusSecurityGroupCheck.key !== securityKey ||
    Date.now() - nebiusSecurityGroupCheck.checked_at > NETWORK_CACHE_MS
  ) {
    nebiusSecurityGroupCheck = {
      key: securityKey,
      checked_at: Date.now(),
      security_group_id:
        await nebiusProvider.ensureManagedComputeSecurityGroup(creds),
    };
  }
  return nebiusSecurityGroupCheck.security_group_id;
}

export async function getProviderComputePublicEgressBytes(opts: {
  vm: ComputeVmRow;
  start: Date;
  end: Date;
}): Promise<number> {
  if (opts.vm.provider === "nebius") return 0;
  const instanceId = gcpInstanceIdForEgress(opts.vm);
  if (instanceId == null) return 0;
  const config = await getComputeVmConfig();
  if (!config.gcp_service_account_json || !config.gcp_project_id) {
    throw new Error(
      "managed compute egress metering credentials are not configured",
    );
  }
  const auth = new GoogleAuth({
    credentials: JSON.parse(config.gcp_service_account_json),
    scopes: ["https://www.googleapis.com/auth/monitoring.read"],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const headers = { Authorization: `Bearer ${token.token ?? token}` };
  let pageToken = "";
  let bytes = 0;
  do {
    const url = new URL(
      `https://monitoring.googleapis.com/v3/projects/${config.gcp_project_id}/timeSeries`,
    );
    url.searchParams.set(
      "filter",
      [
        'metric.type="networking.googleapis.com/vm_flow/egress_bytes_count"',
        `resource.labels.instance_id="${instanceId}"`,
        'metric.labels.remote_location_type="EXTERNAL"',
      ].join(" AND "),
    );
    url.searchParams.set("interval.startTime", opts.start.toISOString());
    url.searchParams.set("interval.endTime", opts.end.toISOString());
    url.searchParams.set("view", "FULL");
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(
        `failed to query managed compute public egress: HTTP ${response.status} ${await response.text()}`,
      );
    }
    const payload: any = await response.json();
    for (const series of payload.timeSeries ?? []) {
      for (const point of series.points ?? []) {
        const value = Number(
          point?.value?.int64Value ?? point?.value?.doubleValue ?? 0,
        );
        if (Number.isFinite(value) && value > 0) bytes += value;
      }
    }
    pageToken = `${payload.nextPageToken ?? ""}`;
  } while (pageToken);
  return Math.floor(bytes);
}

export function gcpInstanceIdForEgress(vm: ComputeVmRow): string | undefined {
  const instanceId = `${vm.metadata?.runtime?.gcp_instance_id ?? ""}`.trim();
  if (instanceId) return instanceId;
  if (vm.deleted_at && !vm.ready_at) return undefined;
  throw new Error(`compute VM '${vm.id}' has no GCP numeric instance id`);
}

export async function listProviderComputeInventory(opts: {
  vms: ComputeVmRow[];
  volumes: ComputeVolumeRow[];
}) {
  const instances: Array<{
    provider: "gcp" | "nebius";
    instance_id: string;
    name?: string;
    status?: string;
    region?: string;
    zone?: string;
  }> = [];
  const disks: Array<{
    provider: "gcp" | "nebius";
    name: string;
    id?: string;
    region?: string;
    zone?: string;
  }> = [];
  const addresses: Array<{
    provider: "gcp" | "nebius";
    id: string;
    ip?: string;
    region?: string;
  }> = [];
  const providers = new Set([
    ...opts.vms.map(({ provider }) => provider),
    ...opts.volumes.map(({ provider }) => provider),
  ]);
  const config = await getComputeVmConfig();
  let disks_observed = false;
  let addresses_observed = false;
  if (
    providers.has("gcp") &&
    config.gcp_service_account_json &&
    config.gcp_project_id
  ) {
    const { creds } = await context("gcp");
    for (const instance of await gcpProvider.listInstances(creds, {
      namePrefix: "cocalc-vm-",
    })) {
      instances.push({
        provider: "gcp",
        instance_id: instance.instance_id,
        name: instance.name,
        status: instance.status,
        zone: instance.zone,
      });
    }
    const client = new DisksClient({
      credentials: JSON.parse(config.gcp_service_account_json),
    });
    for await (const [zonePath, scoped] of client.aggregatedListAsync({
      project: config.gcp_project_id,
    })) {
      const zone = `${zonePath ?? ""}`.split("/").pop();
      for (const disk of scoped.disks ?? []) {
        if (
          disk.name?.startsWith("cocalc-vm-") ||
          disk.name?.startsWith("cocalc-vol-")
        ) {
          disks.push({
            provider: "gcp",
            id: `${disk.name}`,
            name: disk.name,
            zone,
          });
        }
      }
    }
    disks_observed = true;
    const addressClient = new AddressesClient({
      credentials: JSON.parse(config.gcp_service_account_json),
    });
    for await (const [regionPath, scoped] of addressClient.aggregatedListAsync({
      project: config.gcp_project_id,
    })) {
      const region = `${regionPath ?? ""}`.split("/").pop();
      for (const address of scoped.addresses ?? []) {
        if (`${address.name ?? ""}`.startsWith("cocalc-vm-")) {
          addresses.push({
            provider: "gcp",
            id: `${address.name}`,
            ip: address.address ?? undefined,
            region,
          });
        }
      }
    }
    addresses_observed = true;
  }
  const settings = await getServerSettings();
  const nebiusRegions = new Set([
    ...getNebiusRegionKeys(settings),
    ...opts.vms
      .filter(({ provider }) => provider === "nebius")
      .map(({ region }) => region),
    ...opts.volumes
      .filter(({ provider }) => provider === "nebius")
      .map(({ region }) => region),
  ]);
  for (const region of nebiusRegions) {
    const { creds } = await context("nebius", region);
    for (const instance of await nebiusProvider.listInstances(creds, {
      namePrefix: "cocalc-vm-",
    })) {
      instances.push({
        provider: "nebius",
        instance_id: instance.instance_id,
        name: instance.name,
        status: instance.status,
        region,
      });
    }
    for (const disk of await nebiusProvider.listPersistentDisks(creds, {
      namePrefix: "cocalc-",
    })) {
      disks.push({
        provider: "nebius",
        id: disk.id,
        name: disk.name,
        region,
      });
    }
    for (const address of await nebiusProvider.listPublicAddresses(creds, {
      namePrefix: "cocalc-vm-",
    })) {
      addresses.push({
        provider: "nebius",
        id: address.id,
        ip: address.ip,
        region,
      });
    }
    disks_observed = true;
    addresses_observed = true;
  }
  return {
    instances,
    disks,
    addresses,
    disks_observed,
    addresses_observed,
  };
}

type OrphanProviderResource = {
  provider: "gcp" | "nebius";
  resource_id: string;
  resource_name?: string;
  region?: string;
  zone?: string;
};

function orphanRuntime(resource: OrphanProviderResource): HostRuntime {
  return {
    provider: resource.provider,
    instance_id: resource.resource_id,
    ssh_user: "user",
    zone: resource.zone,
    metadata: {
      instance_name: resource.resource_name,
    },
  } as HostRuntime;
}

export async function stopOrphanProviderComputeInstance(
  resource: OrphanProviderResource,
): Promise<void> {
  const { creds } = await context(resource.provider, resource.region);
  const provider = resource.provider === "gcp" ? gcpProvider : nebiusProvider;
  try {
    await provider.stopHost(orphanRuntime(resource), creds);
  } catch (err) {
    if (
      !isProviderNotFound(err) &&
      !/already.*stopped|terminated/i.test(`${err}`)
    ) {
      throw err;
    }
  }
}

export async function deleteOrphanProviderComputeInstance(
  resource: OrphanProviderResource,
): Promise<void> {
  const { creds } = await context(resource.provider, resource.region);
  const provider = resource.provider === "gcp" ? gcpProvider : nebiusProvider;
  try {
    await provider.deleteHost(orphanRuntime(resource), creds, {
      preserveDataDisk: true,
    });
  } catch (err) {
    if (!isProviderNotFound(err)) throw err;
  }
}

export async function deleteOrphanProviderComputeAddress(
  resource: OrphanProviderResource,
): Promise<void> {
  if (resource.provider === "nebius") {
    const { creds } = await context("nebius", resource.region);
    await nebiusProvider.releasePublicAddress(resource.resource_id, creds);
    return;
  }
  if (!resource.region) throw new Error("orphan GCP address has no region");
  const config = await getComputeVmConfig();
  const { options, project } = gcpClientOptions(config);
  try {
    const [operation] = await new AddressesClient(options).delete({
      project,
      region: resource.region,
      address: resource.resource_name ?? resource.resource_id,
    });
    await waitForRegionalOperation({
      response: operation,
      config,
      region: resource.region,
    });
  } catch (err) {
    if (!isProviderNotFound(err)) throw err;
  }
}

export async function deleteOrphanProviderComputeBootDisk(
  resource: OrphanProviderResource,
): Promise<void> {
  const name = `${resource.resource_name ?? ""}`;
  if (!name.startsWith("cocalc-vm-")) {
    throw new Error("refusing to automatically delete a non-boot VM disk");
  }
  if (resource.provider === "nebius") {
    const { creds } = await context("nebius", resource.region);
    await nebiusProvider.deletePersistentDisk({ name }, creds);
    return;
  }
  if (!resource.zone) throw new Error("orphan GCP boot disk has no zone");
  const config = await getComputeVmConfig();
  const { options, project } = gcpClientOptions(config);
  try {
    const [operation] = await new DisksClient(options).delete({
      project,
      zone: resource.zone,
      disk: name,
    });
    await waitForZonalOperation({
      response: operation,
      config,
      zone: resource.zone,
    });
  } catch (err) {
    if (!isProviderNotFound(err)) throw err;
  }
}

function gcpPublicAddressName(vm: ComputeVmRow): string {
  return (
    `${vm.public_address_id ?? ""}`.trim() ||
    `${vm.metadata?.provider_instance_name ?? vm.provider_instance_id}-ip`.slice(
      0,
      63,
    )
  );
}

export async function ensureProviderComputePublicAddress(
  vm: ComputeVmRow,
): Promise<{ id: string; ip: string }> {
  if (vm.provider === "nebius") {
    const { creds } = await context("nebius", vm.region);
    return await nebiusProvider.ensurePublicAddress(
      {
        id: vm.public_address_id ?? undefined,
        name: `${vm.metadata?.provider_instance_name ?? vm.provider_instance_id}-ip`,
      },
      creds,
    );
  }
  const config = await getComputeVmConfig();
  const { options, project } = gcpClientOptions(config);
  const client = new AddressesClient(options);
  const id = gcpPublicAddressName(vm);
  let address: any;
  try {
    [address] = await client.get({ project, region: vm.region, address: id });
  } catch (err) {
    if (!isProviderNotFound(err)) throw err;
    const [operation] = await client.insert({
      project,
      region: vm.region,
      addressResource: {
        name: id,
        addressType: "EXTERNAL",
        networkTier: "STANDARD",
        labels: {
          "managed-by": "cocalc-compute",
          "logical-vm": vm.id.replaceAll("-", "").slice(0, 40),
          owner: vm.owner_account_id.replaceAll("-", "").slice(0, 40),
          environment: config.environment,
        },
      },
    });
    await waitForRegionalOperation({
      response: operation,
      config,
      region: vm.region,
    });
    [address] = await client.get({ project, region: vm.region, address: id });
  }
  const ip = `${address?.address ?? ""}`.trim();
  if (!ip) throw new Error(`GCP address '${id}' has no IPv4 value`);
  if (`${address?.networkTier ?? ""}` !== "STANDARD") {
    throw new Error(`GCP address '${id}' is not Standard Tier`);
  }
  return { id, ip };
}

export async function ensureProviderComputePublicAddressAttached(
  vm: ComputeVmRow,
): Promise<void> {
  if (vm.provider !== "gcp") {
    // Nebius binds the preallocated address in the immutable instance spec.
    return;
  }
  if (!vm.public_ip) throw new Error("managed compute public IP is missing");
  if (!vm.zone) throw new Error("GCP managed compute VM zone is missing");
  const config = await getComputeVmConfig();
  const { options, project } = gcpClientOptions(config);
  const client = new InstancesClient(options);
  let instance: any;
  try {
    [instance] = await client.get({
      project,
      zone: vm.zone,
      instance: vm.provider_instance_id,
    });
  } catch (err) {
    if (isProviderNotFound(err)) return;
    throw err;
  }
  const nic = instance?.networkInterfaces?.[0];
  const access = nic?.accessConfigs?.[0];
  if (`${access?.natIP ?? ""}` === vm.public_ip) return;
  if (access?.name) {
    const [operation] = await client.deleteAccessConfig({
      project,
      zone: vm.zone,
      instance: vm.provider_instance_id,
      networkInterface: `${nic?.name ?? "nic0"}`,
      accessConfig: `${access.name}`,
    });
    await waitForZonalOperation({ response: operation, config, zone: vm.zone });
  }
  const [operation] = await client.addAccessConfig({
    project,
    zone: vm.zone,
    instance: vm.provider_instance_id,
    networkInterface: `${nic?.name ?? "nic0"}`,
    accessConfigResource: {
      name: "External NAT",
      type: "ONE_TO_ONE_NAT",
      networkTier: "STANDARD",
      natIP: vm.public_ip,
    },
  });
  await waitForZonalOperation({ response: operation, config, zone: vm.zone });
}

export async function releaseProviderComputePublicAddress(
  vm: ComputeVmRow,
): Promise<void> {
  if (vm.provider === "nebius") {
    if (!vm.public_address_id) return;
    const { creds } = await context("nebius", vm.region);
    await nebiusProvider.releasePublicAddress(vm.public_address_id, creds);
    return;
  }
  const config = await getComputeVmConfig();
  const { options, project } = gcpClientOptions(config);
  if (vm.zone) {
    const instances = new InstancesClient(options);
    try {
      const [instance] = await instances.get({
        project,
        zone: vm.zone,
        instance: vm.provider_instance_id,
      });
      const nic = instance?.networkInterfaces?.[0];
      const access = nic?.accessConfigs?.[0];
      if (access?.name) {
        const [operation] = await instances.deleteAccessConfig({
          project,
          zone: vm.zone,
          instance: vm.provider_instance_id,
          networkInterface: `${nic?.name ?? "nic0"}`,
          accessConfig: `${access.name}`,
        });
        await waitForZonalOperation({
          response: operation,
          config,
          zone: vm.zone,
        });
      }
    } catch (err) {
      if (!isProviderNotFound(err)) throw err;
    }
  }
  const id = `${vm.public_address_id ?? ""}`.trim();
  if (!id) return;
  const addresses = new AddressesClient(options);
  try {
    const [operation] = await addresses.delete({
      project,
      region: vm.region,
      address: id,
    });
    await waitForRegionalOperation({
      response: operation,
      config,
      region: vm.region,
    });
  } catch (err) {
    if (!isProviderNotFound(err)) throw err;
  }
}

export async function createProviderComputeVm(
  vm: ComputeVmRow,
  volume?: ComputeVolumeRow,
) {
  const { config, creds } = await context(vm.provider, vm.region);
  const selectedProvider = vm.provider === "gcp" ? gcpProvider : nebiusProvider;
  const controller = await getHostOwnerBaySshIdentity();
  const providerVm: ComputeVmRow = {
    ...vm,
    metadata: {
      ...vm.metadata,
      ssh_public_keys: Array.from(
        new Set([
          ...(vm.metadata?.ssh_public_keys ?? []),
          controller.publicKey,
        ]),
      ),
    },
  };
  const subnetwork =
    vm.provider === "gcp"
      ? await requireProviderComputeSubnetwork(requireGcpZone(vm))
      : undefined;
  if (vm.provider === "gcp") {
    await assertProviderComputeNetworkSecurity(config);
  }
  return await selectedProvider.createHost(
    await resolvedSpecFor(providerVm, config, subnetwork, undefined, volume),
    creds,
  );
}

export async function startProviderComputeVm(vm: ComputeVmRow) {
  const { creds } = await context(vm.provider, vm.region);
  await (vm.provider === "gcp" ? gcpProvider : nebiusProvider).startHost(
    runtimeFor(vm),
    creds,
  );
}

export async function setProviderComputeMachineType(vm: ComputeVmRow) {
  if (vm.provider !== "gcp") return;
  const { creds } = await context("gcp", vm.region);
  if (!gcpProvider.setMachineType) {
    throw new Error("GCP machine type changes are unavailable");
  }
  await gcpProvider.setMachineType(runtimeFor(vm), vm.machine_type, creds);
}

export async function ensureProviderComputeSshAccess(vm: ComputeVmRow) {
  const { creds } = await context(vm.provider, vm.region);
  const controller = await getHostOwnerBaySshIdentity();
  if ((vm.operating_system ?? "linux") === "windows") {
    await runProviderComputeWindowsPowerShell(
      vm,
      managedWindowsSshKeysScript([
        vm.ssh_public_key,
        ...(vm.metadata?.ssh_public_keys ?? []),
        controller.publicKey,
      ]),
      controller,
    );
    return;
  }
  if (vm.provider === "nebius") {
    const host = vm.public_hostname || vm.public_ip;
    if (!host) throw new Error("managed compute VM has no SSH address");
    const keys = Array.from(
      new Set([
        vm.ssh_public_key,
        ...(vm.metadata?.ssh_public_keys ?? []),
        controller.publicKey,
      ]),
    )
      .map((key) => `${key ?? ""}`.trim())
      .filter(Boolean)
      .join("\n");
    const encoded = Buffer.from(`${keys}\n`).toString("base64");
    await execFileAsync(
      "ssh",
      [
        "-i",
        controller.privateKeyPath,
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "UserKnownHostsFile=/dev/null",
        `user@${host}`,
        "bash",
        "-lc",
        `echo '${encoded}' | base64 -d > ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
      ],
      { timeout: 30_000 },
    );
    return;
  }
  await gcpProvider.ensureSshAccess(
    runtimeFor({
      ...vm,
      metadata: {
        ...vm.metadata,
        ssh_public_keys: Array.from(
          new Set([
            ...(vm.metadata?.ssh_public_keys ?? []),
            controller.publicKey,
          ]),
        ),
      },
    }),
    creds,
  );
}

async function runProviderComputeWindowsPowerShell(
  vm: ComputeVmRow,
  script: string,
  identity?: { privateKeyPath: string },
): Promise<void> {
  const host = vm.public_hostname || vm.public_ip;
  if (!host) throw new Error("managed compute VM has no SSH address");
  const selectedIdentity = identity ?? (await getHostOwnerBaySshIdentity());
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  await execFileAsync(
    "ssh",
    [
      "-i",
      selectedIdentity.privateKeyPath,
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "ConnectTimeout=10",
      `${vm.ssh_user || "user"}@${host}`,
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encoded,
    ],
    { timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
}

export async function prepareProviderComputeWindowsRdp(
  vm: ComputeVmRow,
  password: string,
): Promise<void> {
  if ((vm.operating_system ?? "linux") !== "windows") {
    throw new Error("RDP preparation requires a Windows VM");
  }
  if (vm.state !== "ready") {
    throw new Error(`compute VM '${vm.name}' is not ready`);
  }
  const passwordBase64 = Buffer.from(password, "utf8").toString("base64");
  const script = `$ErrorActionPreference = "Stop"
$passwordText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${passwordBase64}"))
$securePassword = ConvertTo-SecureString $passwordText -AsPlainText -Force
Set-LocalUser -Name "user" -Password $securePassword -PasswordNeverExpires $true
Set-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" -Name fDenyTSConnections -Value 0
Set-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp" -Name UserAuthentication -Value 1
Enable-NetFirewallRule -DisplayGroup "Remote Desktop"
Write-Output "rdp-ready"`;
  await runProviderComputeWindowsPowerShell(vm, script);
}

export async function stopProviderComputeVm(vm: ComputeVmRow) {
  const { creds } = await context(vm.provider, vm.region);
  try {
    await (vm.provider === "gcp" ? gcpProvider : nebiusProvider).stopHost(
      runtimeFor(vm),
      creds,
    );
  } catch (err) {
    if (
      !isProviderNotFound(err) &&
      !/already.*stopped|terminated|not.*running/i.test(`${err}`)
    ) {
      throw err;
    }
  }
}

export async function detachNebiusComputeVmForIntentionalStop(
  vm: ComputeVmRow,
) {
  if (vm.provider !== "nebius") return;
  const { creds } = await context("nebius", vm.region);
  await nebiusProvider.deleteInstanceOnly(runtimeFor(vm), creds);
}

export async function deleteProviderComputeVm(vm: ComputeVmRow) {
  const { creds } = await context(vm.provider, vm.region);
  const runtime = runtimeFor(vm);
  if (vm.provider === "gcp") {
    await gcpProvider.deleteHost(runtime, creds, { preserveDataDisk: true });
    await gcpProvider.deletePersistentBootDisk(runtime, creds);
  } else {
    await nebiusProvider.deleteHost(runtime, creds, {
      preserveDataDisk: true,
    });
  }
}

export async function inspectProviderComputeVm(vm: ComputeVmRow) {
  if (providerInstanceIdIsProvisional(vm)) {
    return { status: "missing" as const, instance: undefined };
  }
  const { config, creds } = await context(vm.provider, vm.region);
  const selectedProvider = vm.provider === "gcp" ? gcpProvider : nebiusProvider;
  try {
    const subnetwork =
      vm.provider === "gcp"
        ? await requireProviderComputeSubnetwork(requireGcpZone(vm))
        : undefined;
    const runtime = runtimeFor(vm);
    const [status, instance] = await Promise.all([
      selectedProvider.getStatus(runtime, creds),
      selectedProvider.getInstance(runtime, creds),
    ]);
    if (instance && vm.provider === "gcp") {
      assertComputeVmSecurity(instance, config, subnetwork);
    } else if (instance && vm.provider === "nebius") {
      const expectedSecurityGroupId =
        await ensureNebiusManagedComputeSecurityGroup(vm.region);
      const observedSecurityGroupIds = Array.isArray(
        instance.metadata?.security_group_ids,
      )
        ? instance.metadata.security_group_ids
        : [];
      if (
        observedSecurityGroupIds.length !== 1 ||
        observedSecurityGroupIds[0] !== expectedSecurityGroupId
      ) {
        throw new Error(
          `Nebius managed VM '${vm.id}' has invalid security groups`,
        );
      }
      if (instance.metadata?.service_account_id) {
        throw new Error(
          `Nebius managed VM '${vm.id}' has a cloud service account`,
        );
      }
    }
    return { status, instance };
  } catch (err) {
    if (/not found|was not found|code.?5/i.test(`${err}`)) {
      return { status: "missing" as const, instance: undefined };
    }
    throw err;
  }
}

export async function setProviderComputePricing(
  vm: ComputeVmRow,
  pricingModel: "spot" | "on_demand",
) {
  if (providerInstanceIdIsProvisional(vm)) return;
  const { creds } = await context(vm.provider, vm.region);
  if (vm.provider === "gcp") {
    await gcpProvider.setPricingModel(runtimeFor(vm), pricingModel, creds);
  } else {
    await nebiusProvider.setPricingModel(runtimeFor(vm), pricingModel, creds);
  }
}

export async function probeProviderComputeSpot(vm: ComputeVmRow) {
  if (vm.provider !== "gcp") return true;
  const { config, creds } = await context();
  const subnetwork = await requireProviderComputeSubnetwork(requireGcpZone(vm));
  return await gcpProvider.probeSpotAvailability(
    specFor(vm, config, subnetwork, "spot"),
    creds,
    {
      stableForMs: 10_000,
    },
  );
}

export async function ensureProviderComputeVolume(volume: ComputeVolumeRow) {
  const { creds } = await context(volume.provider, volume.region);
  const spec = {
    name: volume.provider_disk_id,
    size_gb: volume.desired_size_gb,
    disk_type: volume.disk_type,
    labels: {
      "managed-by": "cocalc-compute",
      "logical-volume": volume.id.replaceAll("-", "").slice(0, 40),
      owner: volume.owner_account_id.replaceAll("-", "").slice(0, 40),
    },
  };
  if (volume.provider === "gcp") {
    if (volume.disk_type !== "balanced") {
      throw new Error(
        `managed GCP volume '${volume.id}' has invalid disk type '${volume.disk_type}'`,
      );
    }
    return await gcpProvider.ensurePersistentDisk(
      { ...spec, disk_type: "balanced", zone: requireGcpZone(volume) },
      creds,
    );
  }
  return await nebiusProvider.ensurePersistentDisk(spec, creds);
}

export async function inspectProviderComputeVolume(volume: ComputeVolumeRow) {
  const { creds } = await context(volume.provider, volume.region);
  return volume.provider === "gcp"
    ? await gcpProvider.inspectPersistentDisk(
        { name: volume.provider_disk_id, zone: requireGcpZone(volume) },
        creds,
      )
    : await nebiusProvider.inspectPersistentDisk(
        { name: volume.provider_disk_id },
        creds,
      );
}

export async function resizeProviderComputeVolume(volume: ComputeVolumeRow) {
  const { creds } = await context(volume.provider, volume.region);
  const spec = {
    name: volume.provider_disk_id,
    size_gb: volume.desired_size_gb,
  };
  if (volume.provider === "gcp") {
    await gcpProvider.resizePersistentDisk(
      { ...spec, zone: requireGcpZone(volume) },
      creds,
    );
  } else {
    await nebiusProvider.resizePersistentDisk(spec, creds);
  }
}

export async function deleteProviderComputeVolume(volume: ComputeVolumeRow) {
  const { creds } = await context(volume.provider, volume.region);
  if (volume.provider === "gcp") {
    await gcpProvider.deletePersistentDisk(
      { name: volume.provider_disk_id, zone: requireGcpZone(volume) },
      creds,
    );
  } else {
    await nebiusProvider.deletePersistentDisk(
      { name: volume.provider_disk_id },
      creds,
    );
  }
}
