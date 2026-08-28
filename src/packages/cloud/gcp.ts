import {
  DisksClient,
  FirewallsClient,
  GlobalOperationsClient,
  ImagesClient,
  InstancesClient,
  ZoneOperationsClient,
} from "@google-cloud/compute";
import { randomUUID } from "crypto";
import logger from "./logger";
import { gcpInternalHostname } from "./gcp-internal";
import type {
  CloudProvider,
  HostRuntime,
  HostSpec,
  PublicIngressResult,
  PublicIngressSpec,
  RemoteInstance,
} from "./types";

const PROJECT_HOST_PUBLIC_HTTPS_FIREWALL = "cocalc-project-host-public-https";
const PROJECT_HOST_PUBLIC_HTTPS_TAG = "cocalc-project-host-public-https";

type GcpCredentials = {
  service_account_json?: string;
  // this is the google cloud project_id, not a cocalc project_id
  project_id?: string;
  client_email?: string;
  private_key?: string;
};

function parseCredentials(creds: GcpCredentials) {
  if (creds.service_account_json) {
    try {
      const parsed = JSON.parse(creds.service_account_json);
      return {
        projectId: parsed.project_id,
        credentials: {
          client_email: parsed.client_email,
          private_key: parsed.private_key,
        },
        fallback: true,
      };
    } catch (err) {
      throw new Error(`invalid service_account_json: ${err}`);
    }
  }
  if (creds.project_id && creds.client_email && creds.private_key) {
    return {
      projectId: creds.project_id,
      credentials: {
        client_email: creds.client_email,
        private_key: creds.private_key,
      },
      fallback: true,
    };
  }
  throw new Error("missing GCP credentials");
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as {
    code?: number;
    status?: number;
    statusCode?: number;
    message?: string;
    details?: string;
  };
  const code = anyErr.code ?? anyErr.status ?? anyErr.statusCode;
  if (code === 404 || code === 5) return true;
  const msg = String(anyErr.message ?? anyErr.details ?? "");
  return /not found/i.test(msg);
}

function isAlreadyExistsError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as {
    code?: number;
    status?: number;
    statusCode?: number;
    message?: string;
    details?: string;
    errors?: { reason?: string; message?: string }[];
  };
  const code = anyErr.code ?? anyErr.status ?? anyErr.statusCode;
  if (code === 409 || code === 6) return true;
  const errors = Array.isArray(anyErr.errors) ? anyErr.errors : [];
  if (
    errors.some(
      (err) =>
        /alreadyExists/i.test(`${err.reason ?? ""}`) ||
        /already exists/i.test(`${err.message ?? ""}`),
    )
  ) {
    return true;
  }
  const msg = String(anyErr.message ?? anyErr.details ?? "");
  return /alreadyExists/i.test(msg) || /already exists/i.test(msg);
}

function isFingerprintConflictError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as {
    code?: number;
    status?: number;
    statusCode?: number;
    message?: string;
    details?: string;
  };
  const code = anyErr.code ?? anyErr.status ?? anyErr.statusCode;
  if (code === 409 || code === 412) return true;
  const msg = String(anyErr.message ?? anyErr.details ?? "");
  return /fingerprint/i.test(msg) || /conditionNotMet/i.test(msg);
}

function isStartResourceNotReadyFingerprintError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as { message?: string; details?: string };
  const msg = String(anyErr.message ?? anyErr.details ?? "");
  return (
    /RESOURCE_NOT_READY/i.test(msg) &&
    /fingerprint changed during the start operation/i.test(msg)
  );
}

function isRetryableOperationWaitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as {
    code?: string | number;
    message?: string;
    details?: string;
  };
  const code = `${anyErr.code ?? ""}`.trim().toUpperCase();
  if (
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ECONNABORTED" ||
    code === "EAI_AGAIN"
  ) {
    return true;
  }
  const msg = String(anyErr.message ?? anyErr.details ?? "");
  return /timed out/i.test(msg) || /ECONNRESET/i.test(msg);
}

function publicIpFromInstance(instance: any): string {
  return instance?.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP ?? "";
}

function privateIpFromInstance(instance: any): string {
  return instance?.networkInterfaces?.[0]?.networkIP ?? "";
}

function dataDiskUriFromInstance(instance: any): string | undefined {
  const disks = instance?.disks ?? [];
  const dataDisk =
    disks.find(
      (disk) =>
        !disk.boot &&
        disk.type !== "SCRATCH" &&
        !`${disk.deviceName ?? ""}`.endsWith("-scratch"),
    ) ?? disks.find((disk) => !disk.boot);
  return dataDisk?.source ?? undefined;
}

function attachedDiskName(disk: any): string | undefined {
  return (
    disk?.deviceName ??
    (disk?.source ? `${disk.source}`.split("/").pop() : undefined)
  );
}

function attachedDiskSource(disk: any): string | undefined {
  return disk?.source ?? undefined;
}

function spotScheduling() {
  return {
    onHostMaintenance: "TERMINATE",
    automaticRestart: false,
    preemptible: true,
    provisioningModel: "SPOT",
    instanceTerminationAction: "STOP",
  } as const;
}

function pricingModelFromInstance(
  instance: any,
): NonNullable<HostSpec["pricing_model"]> {
  const scheduling = instance?.scheduling ?? {};
  const provisioningModel = `${scheduling?.provisioningModel ?? ""}`
    .trim()
    .toUpperCase();
  if (provisioningModel === "SPOT" || scheduling?.preemptible === true) {
    return "spot";
  }
  return "on_demand";
}

function onDemandScheduling(opts: { gpu?: boolean }) {
  return {
    onHostMaintenance: opts.gpu ? "TERMINATE" : "MIGRATE",
    automaticRestart: true,
    preemptible: false,
    provisioningModel: "STANDARD",
  } as const;
}

function diskTypeFor(spec: HostSpec): string {
  return gcpDiskTypeFor(spec.disk_type);
}

function sharedScratchDiskTypeFor(spec: HostSpec): string {
  return gcpDiskTypeFor(spec.shared_disk_type ?? "balanced");
}

function gcpDiskTypeFor(type?: HostSpec["disk_type"]): string {
  switch (type) {
    case "ssd":
      return "pd-ssd";
    case "balanced":
      return "pd-balanced";
    case "standard":
      return "pd-standard";
    default:
      return "pd-balanced";
  }
}

function machineTypeFor(spec: HostSpec): string {
  const override = spec.metadata?.machine_type;
  if (override) return override;
  const memoryMb = Math.max(1024, Math.round(spec.ram_gb * 1024));
  return `n2-custom-${spec.cpu}-${memoryMb}`;
}

function zoneFor(spec: HostSpec): string {
  if (spec.zone) return spec.zone;
  return `${spec.region}-a`;
}

function startupScriptFor(spec: HostSpec): string | undefined {
  const direct = spec.metadata?.startup_script;
  if (direct) return direct;
  const url = spec.metadata?.bootstrap_url;
  if (!url) return undefined;
  return `#!/bin/bash\nset -e\ncurl -fsSL ${url} | bash`;
}

function sshUserFor(spec: HostSpec): string {
  return spec.metadata?.ssh_user ?? "ubuntu";
}

function normalizeSourceImage(value?: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function defaultImageFamilies(_opts?: { gpu?: boolean }): string[] {
  return [
    "ubuntu-2404-lts-amd64",
    "ubuntu-2404-lts",
    "ubuntu-minimal-2404-lts-amd64",
    "ubuntu-minimal-2404-lts",
  ];
}

async function resolveSourceImage({
  spec,
  credentials,
}: {
  spec: HostSpec;
  credentials: { projectId: string; credentials: any };
}): Promise<string> {
  const imagesClient = new ImagesClient(credentials);
  const gpuPreferred = !!spec.gpu;
  const projectOverride = normalizeSourceImage(
    spec.metadata?.source_image_project,
  );
  const projectCandidates = projectOverride
    ? [projectOverride]
    : gpuPreferred
      ? ["ubuntu-os-accelerator-images", "ubuntu-os-cloud"]
      : ["ubuntu-os-cloud", "ubuntu-os-accelerator-images"];

  const direct = normalizeSourceImage(spec.metadata?.source_image);
  if (direct) {
    if (
      direct.startsWith("http://") ||
      direct.startsWith("https://") ||
      direct.startsWith("projects/") ||
      direct.includes("/global/images/")
    ) {
      return direct;
    }
    for (const project of projectCandidates) {
      try {
        const [img] = await imagesClient.get({
          project,
          image: direct,
        });
        if (img?.selfLink) {
          return img.selfLink;
        }
      } catch (err) {
        logger.warn("gcp source_image lookup failed", {
          image: direct,
          project,
          err: String(err),
        });
      }
    }
  }

  const familyOverride =
    normalizeSourceImage(spec.metadata?.source_image_family) ??
    normalizeSourceImage(spec.metadata?.image_family);
  const familyCandidates = familyOverride
    ? [familyOverride]
    : defaultImageFamilies({ gpu: gpuPreferred });
  for (const project of projectCandidates) {
    for (const family of familyCandidates) {
      try {
        const [img] = await imagesClient.getFromFamily({
          project,
          family,
        });
        if (img?.selfLink) {
          return img.selfLink;
        }
      } catch (err) {
        logger.warn("gcp image family lookup failed", {
          family,
          project,
          err: String(err),
        });
      }
    }
  }

  throw new Error(
    `unable to resolve gcp source image (family=${familyOverride ?? "default"})`,
  );
}

async function waitUntilOperationComplete({
  response,
  zone,
  credentials,
}: {
  response: any;
  zone: string;
  credentials: any;
}) {
  let operation = response?.latestResponse ?? response;
  if (!operation?.name) {
    return;
  }
  const operationsClient = new ZoneOperationsClient(credentials);
  const waitForOperationUpdate = async () => {
    const maxAttempts = 5;
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        const [nextOperation] = await operationsClient.wait({
          operation: operation.name,
          project: credentials.projectId,
          zone,
        });
        return nextOperation;
      } catch (err) {
        const retryable =
          isRetryableOperationWaitError(err) && attempt < maxAttempts;
        if (!retryable) throw err;
        logger.warn("gcp operation wait retry", {
          operation: operation.name,
          project: credentials.projectId,
          zone,
          attempt,
          err: String(err),
        });
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  };
  if (!operation.status) {
    operation = await waitForOperationUpdate();
  }
  while (operation.status !== "DONE") {
    operation = await waitForOperationUpdate();
  }
  const opError = operation?.error;
  const opErrors = Array.isArray(opError?.errors) ? opError.errors : [];
  if (opErrors.length > 0) {
    const summary = opErrors
      .map((err: { code?: string; message?: string }) =>
        [err?.code, err?.message].filter(Boolean).join(": "),
      )
      .filter(Boolean)
      .join("; ");
    throw new Error(summary || "gcp operation failed");
  }
}

async function waitUntilGlobalOperationComplete({
  response,
  credentials,
}: {
  response: any;
  credentials: any;
}) {
  let operation = response?.latestResponse ?? response;
  if (!operation?.name) return;
  const operationsClient = new GlobalOperationsClient(credentials);
  while (operation.status !== "DONE") {
    const [nextOperation] = await operationsClient.wait({
      operation: operation.name,
      project: credentials.projectId,
    });
    operation = nextOperation;
  }
  const errors = Array.isArray(operation?.error?.errors)
    ? operation.error.errors
    : [];
  if (errors.length > 0) {
    const summary = errors
      .map((err: { code?: string; message?: string }) =>
        [err?.code, err?.message].filter(Boolean).join(": "),
      )
      .filter(Boolean)
      .join("; ");
    throw new Error(summary || "gcp global operation failed");
  }
}

async function waitForInstanceLifecycleStatus(opts: {
  client: InstancesClient;
  credentials: any;
  runtime: HostRuntime;
  desired: string[];
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<any | undefined> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  let lastInstance: any | undefined;
  while (Date.now() < deadline) {
    const [instance] = await opts.client.get({
      project: opts.credentials.projectId,
      zone: opts.runtime.zone,
      instance: opts.runtime.instance_id,
    });
    lastInstance = instance;
    const status = `${instance?.status ?? ""}`.trim().toUpperCase();
    if (opts.desired.includes(status)) {
      return instance;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return lastInstance;
}

async function setStandardSchedulingViaRest(opts: {
  client: InstancesClient;
  credentials: any;
  runtime: HostRuntime;
  gpu: boolean;
}) {
  const authClient = await opts.client.auth.getClient();
  const response = await authClient.request({
    url: `https://compute.googleapis.com/compute/v1/projects/${opts.credentials.projectId}/zones/${opts.runtime.zone}/instances/${opts.runtime.instance_id}/setScheduling`,
    method: "POST",
    data: {
      ...onDemandScheduling({ gpu: opts.gpu }),
      // Clearing the Spot-only termination action requires an explicit null.
      instanceTerminationAction: null,
    },
  });
  await waitUntilOperationComplete({
    response: response.data,
    zone: opts.runtime.zone!,
    credentials: opts.credentials,
  });
}

async function resolveSharedScratchDiskName(opts: {
  runtime: HostRuntime;
  credentials: { projectId: string; credentials: any };
}): Promise<string> {
  const metadata = (opts.runtime.metadata ?? {}) as Record<string, any>;
  let diskName =
    metadata.shared_disk_name ??
    metadata.shared_disk_id ??
    (metadata.shared_disk_uri
      ? `${metadata.shared_disk_uri}`.split("/").pop()
      : undefined);
  if (!diskName && opts.runtime.zone) {
    const instanceClient = new InstancesClient(opts.credentials);
    const [instance] = await instanceClient.get({
      project: opts.credentials.projectId,
      zone: opts.runtime.zone,
      instance: opts.runtime.instance_id,
    });
    const disks = instance?.disks ?? [];
    const scratchDisk = disks.find((disk) =>
      `${attachedDiskName(disk) ?? ""}`.endsWith("-scratch"),
    );
    diskName = attachedDiskName(scratchDisk);
  }
  if (!diskName) {
    throw new Error("gcp: no shared scratch disk to resize");
  }
  return diskName;
}

export class GcpProvider implements CloudProvider {
  mapStatus(status?: string): string | undefined {
    if (!status) return undefined;
    const normalized = status.toLowerCase();
    if (normalized === "running") return "running";
    if (
      normalized === "terminated" ||
      normalized === "stopped" ||
      normalized === "stopping"
    )
      return "off";
    return "starting";
  }

  async createHost(spec: HostSpec, creds: any): Promise<HostRuntime> {
    const logMetadata = { ...(spec.metadata ?? {}) } as Record<string, unknown>;
    delete logMetadata.startup_script;
    delete logMetadata.bootstrap_url;
    delete logMetadata.user_data;
    if (logMetadata.instance_metadata) {
      logMetadata.instance_metadata = Object.fromEntries(
        Object.keys(
          logMetadata.instance_metadata as Record<string, unknown>,
        ).map((key) => [
          key,
          key.includes("script") ? "[redacted script]" : "[set]",
        ]),
      );
    }
    logger.info("gcp.createHost", {
      name: spec.name,
      region: spec.region,
      zone: spec.zone,
      disk_gb: spec.disk_gb,
      gpu: spec.gpu?.type ?? "none",
      metadata: logMetadata,
    });
    const credentials = parseCredentials(creds ?? {});
    const client = new InstancesClient(credentials) as InstancesClient & {
      googleProjectId: string;
    };
    client.googleProjectId = credentials.projectId;

    const zone = zoneFor(spec);
    const machineType = `zones/${zone}/machineTypes/${machineTypeFor(spec)}`;
    const diskType = `projects/${credentials.projectId}/zones/${zone}/diskTypes/${diskTypeFor(
      spec,
    )}`;
    const sharedScratchDiskType = `projects/${credentials.projectId}/zones/${zone}/diskTypes/${sharedScratchDiskTypeFor(
      spec,
    )}`;
    const sourceImage = await resolveSourceImage({ spec, credentials });
    const bootDiskGb =
      spec.metadata?.boot_disk_gb ??
      spec.metadata?.bootDiskGb ??
      (spec.gpu ? 20 : 10);
    const persistentBootDisk = spec.metadata?.persistent_boot_disk === true;
    const bootDiskName = spec.metadata?.boot_disk_name ?? `${spec.name}-boot`;
    let bootDiskSource: string | undefined;
    if (persistentBootDisk) {
      const diskClient = new DisksClient(credentials);
      try {
        const [disk] = await diskClient.get({
          project: credentials.projectId,
          zone,
          disk: bootDiskName,
        });
        bootDiskSource = disk?.selfLink ?? undefined;
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
      }
    }

    const storageMode = spec.metadata?.storage_mode;
    type Disk = {
      autoDelete: boolean;
      boot: boolean;
      type?: string;
      interface?: string;
      deviceName?: string;
      initializeParams?: {
        diskType: string;
        diskSizeGb?: string;
        sourceImage?: any;
        diskName?: string;
      };
      source?: string;
    };
    const disks: Disk[] = [
      {
        autoDelete: !persistentBootDisk,
        boot: true,
        deviceName: persistentBootDisk ? bootDiskName : undefined,
        ...(bootDiskSource
          ? { source: bootDiskSource }
          : {
              initializeParams: {
                diskName: persistentBootDisk ? bootDiskName : undefined,
                diskSizeGb: `${bootDiskGb}`,
                diskType,
                sourceImage,
              },
            }),
      },
    ];
    const dataDiskName = spec.metadata?.data_disk_name ?? `${spec.name}-data`;
    const sharedScratchDiskName =
      spec.metadata?.shared_disk_name ?? `${spec.name}-scratch`;
    let dataDiskSource: string | undefined;
    let sharedScratchDiskSource: string | undefined;
    if (storageMode === "ephemeral") {
      // Attach one local SSD for fast ephemeral storage.
      disks.push({
        autoDelete: true,
        boot: false,
        type: "SCRATCH",
        interface: "NVME",
        initializeParams: {
          diskType: `projects/${credentials.projectId}/zones/${zone}/diskTypes/local-ssd`,
        },
      });
    } else if (storageMode !== "boot-only") {
      const diskClient = new DisksClient(credentials);
      try {
        const [disk] = await diskClient.get({
          project: credentials.projectId,
          zone,
          disk: dataDiskName,
        });
        dataDiskSource = disk?.selfLink ?? undefined;
      } catch (err) {
        if (!isNotFoundError(err)) {
          throw err;
        }
      }
      disks.push({
        autoDelete: false,
        boot: false,
        deviceName: dataDiskName,
        ...(dataDiskSource
          ? { source: dataDiskSource }
          : {
              initializeParams: {
                diskName: dataDiskName,
                diskSizeGb: `${spec.disk_gb}`,
                diskType,
              },
            }),
      });
    }

    const sharedDiskGb = Number(spec.shared_disk_gb ?? 0);
    if (Number.isFinite(sharedDiskGb) && sharedDiskGb > 0) {
      const diskClient = new DisksClient(credentials);
      const existingScratchDiskName =
        spec.metadata?.shared_disk_id ??
        spec.metadata?.sharedDiskId ??
        sharedScratchDiskName;
      try {
        const [disk] = await diskClient.get({
          project: credentials.projectId,
          zone,
          disk: existingScratchDiskName,
        });
        sharedScratchDiskSource = disk?.selfLink ?? undefined;
      } catch (err) {
        if (!isNotFoundError(err)) {
          throw err;
        }
      }
      disks.push({
        autoDelete: false,
        boot: false,
        deviceName: sharedScratchDiskName,
        ...(sharedScratchDiskSource
          ? { source: sharedScratchDiskSource }
          : {
              initializeParams: {
                diskName: sharedScratchDiskName,
                diskSizeGb: `${Math.floor(sharedDiskGb)}`,
                diskType: sharedScratchDiskType,
              },
            }),
      });
    }

    const subnetwork =
      `${spec.metadata?.subnetwork_uri ?? ""}`.trim() ||
      `projects/${credentials.projectId}/regions/${spec.region}/subnetworks/default`;
    const networkInterfaces = [
      {
        accessConfigs: [
          {
            name: "External NAT",
            networkTier: "STANDARD",
            natIP: spec.metadata?.public_ip || undefined,
          },
        ],
        stackType: "IPV4_ONLY",
        subnetwork,
      },
    ];

    const metadataItems: { key: string; value: string }[] = [];
    if (spec.metadata?.block_project_ssh_keys === true) {
      metadataItems.push({ key: "block-project-ssh-keys", value: "TRUE" });
    }
    const startupScript = startupScriptFor(spec);
    if (startupScript) {
      metadataItems.push({ key: "startup-script", value: startupScript });
    }
    const sshPublicKeys = normalizeSshKeys(
      spec.metadata?.ssh_public_keys,
      spec.metadata?.ssh_public_key,
    );
    if (sshPublicKeys.length) {
      const sshUser = sshUserFor(spec);
      const entries = sshPublicKeys.map((key) => `${sshUser}:${key}`);
      metadataItems.push({
        key: "ssh-keys",
        value: entries.join("\n"),
      });
    }
    const instanceMetadata = spec.metadata?.instance_metadata;
    if (instanceMetadata && typeof instanceMetadata === "object") {
      const reserved = new Set(metadataItems.map(({ key }) => key));
      for (const [key, rawValue] of Object.entries(instanceMetadata)) {
        if (reserved.has(key)) {
          throw new Error(`gcp: instance metadata key '${key}' is reserved`);
        }
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(key)) {
          throw new Error(`gcp: invalid instance metadata key '${key}'`);
        }
        if (typeof rawValue !== "string") {
          throw new Error(`gcp: instance metadata '${key}' must be a string`);
        }
        metadataItems.push({ key, value: rawValue });
      }
    }

    const guestAccelerators =
      spec.gpu && !machineTypeFor(spec).startsWith("g2-")
        ? [
            {
              acceleratorCount: Math.max(1, spec.gpu.count ?? 1),
              acceleratorType: `projects/${credentials.projectId}/zones/${zone}/acceleratorTypes/${spec.gpu.type}`,
            },
          ]
        : [];
    const scheduling =
      spec.pricing_model === "spot"
        ? spotScheduling()
        : onDemandScheduling({ gpu: !!spec.gpu });

    const instanceResource = {
      name: spec.name,
      disks,
      machineType,
      networkInterfaces,
      metadata: metadataItems.length ? { items: metadataItems } : undefined,
      guestAccelerators,
      tags: spec.tags ? { items: spec.tags } : undefined,
      scheduling,
      labels: spec.metadata?.labels,
      canIpForward: false,
      deletionProtection: false,
      serviceAccounts:
        spec.metadata?.disable_service_account === true ? [] : undefined,
    };

    const runtimeFromInstance = (instance: any): HostRuntime => {
      const publicIp = publicIpFromInstance(instance);
      const privateIp = privateIpFromInstance(instance);
      const internalHostname = gcpInternalHostname({
        configuredHostname: instance?.hostname,
        instanceName: instance?.name ?? spec.name,
        projectId: credentials.projectId,
      });
      return {
        provider: "gcp",
        instance_id: spec.name,
        public_ip: publicIp,
        private_ip: privateIp,
        internal_hostname: internalHostname,
        ssh_user: sshUserFor(spec),
        zone,
        metadata: {
          gcp_project_id: credentials.projectId,
          gcp_instance_id: instance?.id?.toString(),
          machine_type: machineType,
          gpu_count: spec.gpu?.count ?? 0,
          disk_type: diskType,
          boot_disk_gb: bootDiskGb,
          boot_disk_name: persistentBootDisk ? bootDiskName : undefined,
          boot_disk_uri:
            bootDiskSource ??
            attachedDiskSource(
              (instance?.disks ?? []).find((disk) => disk.boot),
            ),
          persistent_boot_disk: persistentBootDisk,
          data_disk_gb: spec.disk_gb,
          data_disk_name: dataDiskName,
          data_disk_uri: dataDiskSource ?? dataDiskUriFromInstance(instance),
          ...(Number.isFinite(sharedDiskGb) && sharedDiskGb > 0
            ? {
                shared_disk_gb: Math.floor(sharedDiskGb),
                shared_disk_type: spec.shared_disk_type ?? "balanced",
                shared_disk_id: sharedScratchDiskName,
                shared_disk_name: sharedScratchDiskName,
                shared_disk_uri:
                  sharedScratchDiskSource ??
                  attachedDiskSource(
                    (instance?.disks ?? []).find(
                      (disk) =>
                        attachedDiskName(disk) === sharedScratchDiskName,
                    ),
                  ),
              }
            : {}),
          ssh_public_key: spec.metadata?.ssh_public_key,
          ssh_public_keys: sshPublicKeys,
          ssh_user: sshUserFor(spec),
          provider_status: instance?.status ?? undefined,
        },
      };
    };
    const recoverExistingRuntime = async (
      err: unknown,
    ): Promise<HostRuntime | undefined> => {
      try {
        const [instance] = await client.get({
          project: credentials.projectId,
          zone,
          instance: spec.name,
        });
        if (!instance) return undefined;
        logger.warn("gcp.createHost recovered existing instance", {
          project: credentials.projectId,
          zone,
          name: spec.name,
          err: String(err),
          status: instance.status,
        });
        return runtimeFromInstance(instance);
      } catch (lookupErr) {
        if (isNotFoundError(lookupErr)) return undefined;
        logger.warn("gcp.createHost existing instance lookup failed", {
          project: credentials.projectId,
          zone,
          name: spec.name,
          err: String(err),
          lookupErr: String(lookupErr),
        });
        return undefined;
      }
    };

    try {
      const [response] = await client.insert({
        project: credentials.projectId,
        zone,
        instanceResource,
      });
      logger.debug("gcp.createHost insert submitted", {
        project: credentials.projectId,
        zone,
        name: spec.name,
      });
      await waitUntilOperationComplete({
        response,
        zone,
        credentials,
      });
    } catch (err) {
      if (isAlreadyExistsError(err) || isRetryableOperationWaitError(err)) {
        const recovered = await recoverExistingRuntime(err);
        if (recovered) return recovered;
      }
      throw err;
    }

    const [instance] = await client.get({
      project: credentials.projectId,
      zone,
      instance: spec.name,
    });

    return runtimeFromInstance(instance);
  }

  async startHost(runtime: HostRuntime, creds: any): Promise<void> {
    logger.info("gcp.startHost", {
      instance_id: runtime.instance_id,
      zone: runtime.zone,
    });
    const credentials = parseCredentials(creds ?? {});
    if (!runtime.zone) {
      throw new Error("gcp.startHost requires zone");
    }
    const client = new InstancesClient(credentials);
    await ensureSshMetadata(runtime, credentials, client);
    await ensureStartupScriptMetadata(runtime, credentials, client);
    const [existing] = await client.get({
      project: credentials.projectId,
      zone: runtime.zone,
      instance: runtime.instance_id,
    });
    const initialStatus = `${existing?.status ?? ""}`.trim().toUpperCase();
    if (initialStatus === "RUNNING") {
      logger.info("gcp.startHost no-op; instance already running", {
        instance_id: runtime.instance_id,
        zone: runtime.zone,
      });
      return;
    }
    if (initialStatus === "STOPPING") {
      await waitForInstanceLifecycleStatus({
        client,
        credentials,
        runtime,
        desired: ["TERMINATED"],
      });
    }
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const [response] = await client.start({
          project: credentials.projectId,
          zone: runtime.zone,
          instance: runtime.instance_id,
        });
        await waitUntilOperationComplete({
          response,
          zone: runtime.zone,
          credentials,
        });
        return;
      } catch (err) {
        const retryable =
          isStartResourceNotReadyFingerprintError(err) && attempt < maxAttempts;
        if (!retryable) throw err;
        logger.warn("gcp.startHost retry after fingerprint race", {
          instance_id: runtime.instance_id,
          zone: runtime.zone,
          attempt,
          err: String(err),
        });
        await ensureSshMetadata(runtime, credentials, client);
        await ensureStartupScriptMetadata(runtime, credentials, client);
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
  }

  async ensureSshAccess(runtime: HostRuntime, creds: any): Promise<void> {
    logger.info("gcp.ensureSshAccess", {
      instance_id: runtime.instance_id,
      zone: runtime.zone,
    });
    const credentials = parseCredentials(creds ?? {});
    if (!runtime.zone) {
      throw new Error("gcp.ensureSshAccess requires zone");
    }
    const client = new InstancesClient(credentials);
    await ensureSshMetadata(runtime, credentials, client);
  }

  async ensurePublicIngress(
    runtime: HostRuntime,
    spec: PublicIngressSpec,
    creds: any,
  ): Promise<PublicIngressResult> {
    if (!runtime.zone) {
      throw new Error("gcp.ensurePublicIngress requires zone");
    }
    const ports = Array.from(
      new Set(
        (spec.ports ?? [])
          .map(Number)
          .filter(
            (port) => Number.isInteger(port) && port > 0 && port <= 65_535,
          ),
      ),
    ).sort((a, b) => a - b);
    const sourceRanges = Array.from(
      new Set(
        (spec.source_ranges ?? [])
          .map((range) => `${range ?? ""}`.trim())
          .filter(Boolean),
      ),
    ).sort();
    if (ports.length === 0) {
      throw new Error("gcp.ensurePublicIngress requires at least one port");
    }
    if (sourceRanges.length === 0) {
      throw new Error(
        "gcp.ensurePublicIngress requires at least one source range",
      );
    }

    const credentials = parseCredentials(creds ?? {});
    const firewalls = new FirewallsClient(credentials);
    const firewallResource = {
      name: PROJECT_HOST_PUBLIC_HTTPS_FIREWALL,
      description:
        "CoCalc project-host HTTPS ingress from Cloudflare proxy edges",
      network: `projects/${credentials.projectId}/global/networks/default`,
      direction: "INGRESS",
      priority: 1000,
      disabled: false,
      allowed: [
        {
          IPProtocol: "tcp",
          ports: ports.map(String),
        },
      ],
      sourceRanges,
      targetTags: [PROJECT_HOST_PUBLIC_HTTPS_TAG],
    };

    let firewallResponse: any;
    try {
      await firewalls.get({
        project: credentials.projectId,
        firewall: PROJECT_HOST_PUBLIC_HTTPS_FIREWALL,
      });
      [firewallResponse] = await firewalls.patch({
        project: credentials.projectId,
        firewall: PROJECT_HOST_PUBLIC_HTTPS_FIREWALL,
        firewallResource,
      });
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      try {
        [firewallResponse] = await firewalls.insert({
          project: credentials.projectId,
          firewallResource,
        });
      } catch (insertErr) {
        if (!isAlreadyExistsError(insertErr)) throw insertErr;
        [firewallResponse] = await firewalls.patch({
          project: credentials.projectId,
          firewall: PROJECT_HOST_PUBLIC_HTTPS_FIREWALL,
          firewallResource,
        });
      }
    }
    await waitUntilGlobalOperationComplete({
      response: firewallResponse,
      credentials,
    });

    const instances = new InstancesClient(credentials);
    let instanceTags: string[] = [];
    let currentInstance: any;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const [instance] = await instances.get({
        project: credentials.projectId,
        zone: runtime.zone,
        instance: runtime.instance_id,
      });
      currentInstance = instance;
      const existingTags = Array.isArray(instance?.tags?.items)
        ? instance.tags.items.map((tag) => `${tag}`)
        : [];
      if (existingTags.includes(PROJECT_HOST_PUBLIC_HTTPS_TAG)) {
        instanceTags = existingTags;
        break;
      }
      try {
        const [response] = await instances.setTags({
          project: credentials.projectId,
          zone: runtime.zone,
          instance: runtime.instance_id,
          tagsResource: {
            fingerprint: instance?.tags?.fingerprint,
            items: [...existingTags, PROJECT_HOST_PUBLIC_HTTPS_TAG],
          },
        });
        await waitUntilOperationComplete({
          response,
          zone: runtime.zone,
          credentials,
        });
        instanceTags = [...existingTags, PROJECT_HOST_PUBLIC_HTTPS_TAG];
        currentInstance = {
          ...instance,
          tags: {
            ...instance?.tags,
            items: instanceTags,
          },
        };
        break;
      } catch (err) {
        if (!isFingerprintConflictError(err) || attempt === 3) throw err;
      }
    }

    const [effectiveRule] = await firewalls.get({
      project: credentials.projectId,
      firewall: PROJECT_HOST_PUBLIC_HTTPS_FIREWALL,
    });
    const [allRules] = await firewalls.list({
      project: credentials.projectId,
    });
    const rulePriority = Number(effectiveRule?.priority ?? 1000);
    const potentialConflicts = (Array.isArray(allRules) ? allRules : [])
      .filter((rule: any) => {
        if (rule?.disabled === true) return false;
        if (`${rule?.direction ?? "INGRESS"}`.toUpperCase() !== "INGRESS") {
          return false;
        }
        if (!Array.isArray(rule?.denied) || rule.denied.length === 0) {
          return false;
        }
        if (Number(rule?.priority ?? 1000) > rulePriority) return false;
        const targetTags = Array.isArray(rule?.targetTags)
          ? rule.targetTags.map((tag: unknown) => `${tag}`)
          : [];
        return (
          targetTags.length === 0 ||
          targetTags.some((tag: string) => instanceTags.includes(tag))
        );
      })
      .map((rule: any) => ({
        name: `${rule?.name ?? ""}` || undefined,
        priority: Number(rule?.priority ?? 1000),
        source_ranges: Array.isArray(rule?.sourceRanges)
          ? rule.sourceRanges.map((range: unknown) => `${range}`)
          : [],
        target_tags: Array.isArray(rule?.targetTags)
          ? rule.targetTags.map((tag: unknown) => `${tag}`)
          : [],
        denied: Array.isArray(rule?.denied) ? rule.denied : [],
      }));
    let effectiveFirewalls: NonNullable<
      PublicIngressResult["effective_firewalls"]
    >;
    try {
      const [response] = await instances.getEffectiveFirewalls({
        project: credentials.projectId,
        zone: runtime.zone,
        instance: runtime.instance_id,
        networkInterface:
          `${currentInstance?.networkInterfaces?.[0]?.name ?? ""}` || undefined,
      });
      effectiveFirewalls = {
        firewalls: (response?.firewalls ?? []).map((rule: any) => ({
          name: `${rule?.name ?? ""}` || undefined,
          priority: Number(rule?.priority ?? 1000),
          direction: `${rule?.direction ?? "INGRESS"}`,
          source_ranges: Array.isArray(rule?.sourceRanges)
            ? rule.sourceRanges.map((range: unknown) => `${range}`)
            : [],
          target_tags: Array.isArray(rule?.targetTags)
            ? rule.targetTags.map((tag: unknown) => `${tag}`)
            : [],
          allowed: Array.isArray(rule?.allowed) ? rule.allowed : [],
          denied: Array.isArray(rule?.denied) ? rule.denied : [],
        })),
        policies: (response?.firewallPolicys ?? []).map((policy: any) => ({
          name: `${policy?.name ?? ""}` || undefined,
          short_name: `${policy?.shortName ?? ""}` || undefined,
          type: `${policy?.type ?? ""}` || undefined,
          priority:
            policy?.priority == null ? undefined : Number(policy.priority),
          rules: (policy?.rules ?? []).map((rule: any) => ({
            action: `${rule?.action ?? ""}` || undefined,
            direction: `${rule?.direction ?? ""}` || undefined,
            disabled: rule?.disabled == null ? undefined : !!rule.disabled,
            priority:
              rule?.priority == null ? undefined : Number(rule.priority),
            rule_name: `${rule?.ruleName ?? ""}` || undefined,
            source_ranges: Array.isArray(rule?.match?.srcIpRanges)
              ? rule.match.srcIpRanges.map((range: unknown) => `${range}`)
              : [],
            destination_ranges: Array.isArray(rule?.match?.destIpRanges)
              ? rule.match.destIpRanges.map((range: unknown) => `${range}`)
              : [],
            layer4_configs: Array.isArray(rule?.match?.layer4Configs)
              ? rule.match.layer4Configs
              : [],
            target_resources: Array.isArray(rule?.targetResources)
              ? rule.targetResources.map((resource: unknown) => `${resource}`)
              : [],
            target_service_accounts: Array.isArray(rule?.targetServiceAccounts)
              ? rule.targetServiceAccounts.map(
                  (account: unknown) => `${account}`,
                )
              : [],
          })),
        })),
      };
    } catch (err) {
      effectiveFirewalls = { error: `${err}` };
      logger.warn("failed reading effective GCP firewalls", {
        instance_id: runtime.instance_id,
        err: `${err}`,
      });
    }
    const result: PublicIngressResult = {
      instance: {
        network:
          `${currentInstance?.networkInterfaces?.[0]?.network ?? ""}` ||
          undefined,
        network_interface:
          `${currentInstance?.networkInterfaces?.[0]?.name ?? ""}` || undefined,
        public_ip:
          `${currentInstance?.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP ?? ""}` ||
          undefined,
        private_ip:
          `${currentInstance?.networkInterfaces?.[0]?.networkIP ?? ""}` ||
          undefined,
        tags: instanceTags,
      },
      rule: {
        name: `${effectiveRule?.name ?? PROJECT_HOST_PUBLIC_HTTPS_FIREWALL}`,
        priority: rulePriority,
        source_ranges: Array.isArray(effectiveRule?.sourceRanges)
          ? effectiveRule.sourceRanges.map((range: unknown) => `${range}`)
          : [],
        target_tags: Array.isArray(effectiveRule?.targetTags)
          ? effectiveRule.targetTags.map((tag: unknown) => `${tag}`)
          : [],
        allowed: Array.isArray(effectiveRule?.allowed)
          ? effectiveRule.allowed
          : [],
      },
      potential_conflicts: potentialConflicts,
      effective_firewalls: effectiveFirewalls,
    };
    logger.info("gcp public HTTPS ingress reconciled", {
      instance_id: runtime.instance_id,
      ...result,
    });
    return result;
  }

  async stopHost(runtime: HostRuntime, creds: any): Promise<void> {
    logger.info("gcp.stopHost", {
      instance_id: runtime.instance_id,
      zone: runtime.zone,
    });
    const credentials = parseCredentials(creds ?? {});
    if (!runtime.zone) {
      throw new Error("gcp.stopHost requires zone");
    }
    const client = new InstancesClient(credentials);
    const [response] = await client.stop({
      project: credentials.projectId,
      zone: runtime.zone,
      instance: runtime.instance_id,
    });
    await waitUntilOperationComplete({
      response,
      zone: runtime.zone,
      credentials,
    });
  }

  async setPricingModel(
    runtime: HostRuntime,
    pricingModel: NonNullable<HostSpec["pricing_model"]>,
    creds: any,
  ): Promise<void> {
    logger.info("gcp.setPricingModel", {
      instance_id: runtime.instance_id,
      zone: runtime.zone,
      pricing_model: pricingModel,
    });
    const credentials = parseCredentials(creds ?? {});
    if (!runtime.zone) {
      throw new Error("gcp.setPricingModel requires zone");
    }
    const client = new InstancesClient(credentials);
    const gpu =
      Number(
        (runtime.metadata as { gpu_count?: number } | undefined)?.gpu_count,
      ) > 0;
    const [instance] = await client.get({
      project: credentials.projectId,
      zone: runtime.zone,
      instance: runtime.instance_id,
    });
    const currentPricingModel = pricingModelFromInstance(instance);
    if (currentPricingModel === pricingModel) {
      logger.info("gcp.setPricingModel no-op; pricing already matches", {
        instance_id: runtime.instance_id,
        zone: runtime.zone,
        pricing_model: pricingModel,
        status: instance?.status,
      });
      return;
    }
    const status = `${instance?.status ?? ""}`.trim().toUpperCase();
    if (
      status === "RUNNING" ||
      status === "PROVISIONING" ||
      status === "STAGING"
    ) {
      const [stopResponse] = await client.stop({
        project: credentials.projectId,
        zone: runtime.zone,
        instance: runtime.instance_id,
      });
      await waitUntilOperationComplete({
        response: stopResponse,
        zone: runtime.zone,
        credentials,
      });
      await waitForInstanceLifecycleStatus({
        client,
        credentials,
        runtime,
        desired: ["TERMINATED"],
      });
    } else if (status === "STOPPING") {
      await waitForInstanceLifecycleStatus({
        client,
        credentials,
        runtime,
        desired: ["TERMINATED"],
      });
    }
    if (pricingModel === "on_demand") {
      await setStandardSchedulingViaRest({
        client,
        credentials,
        runtime,
        gpu,
      });
      return;
    }
    const [response] = await client.setScheduling({
      project: credentials.projectId,
      zone: runtime.zone,
      instance: runtime.instance_id,
      schedulingResource: spotScheduling(),
    });
    await waitUntilOperationComplete({
      response,
      zone: runtime.zone,
      credentials,
    });
  }

  async setMachineType(
    runtime: HostRuntime,
    machineType: string,
    creds: any,
  ): Promise<void> {
    logger.info("gcp.setMachineType", {
      instance_id: runtime.instance_id,
      zone: runtime.zone,
      machine_type: machineType,
    });
    const credentials = parseCredentials(creds ?? {});
    if (!runtime.zone) {
      throw new Error("gcp.setMachineType requires zone");
    }
    const normalized = `${machineType ?? ""}`.trim();
    if (!normalized) {
      throw new Error("gcp.setMachineType requires machineType");
    }
    const client = new InstancesClient(credentials);
    const [instance] = await client.get({
      project: credentials.projectId,
      zone: runtime.zone,
      instance: runtime.instance_id,
    });
    const current = `${instance?.machineType ?? ""}`.split("/").pop();
    if (current === normalized) return;
    const status = `${instance?.status ?? ""}`.trim().toUpperCase();
    if (
      status === "RUNNING" ||
      status === "PROVISIONING" ||
      status === "STAGING"
    ) {
      const [stopResponse] = await client.stop({
        project: credentials.projectId,
        zone: runtime.zone,
        instance: runtime.instance_id,
      });
      await waitUntilOperationComplete({
        response: stopResponse,
        zone: runtime.zone,
        credentials,
      });
      await waitForInstanceLifecycleStatus({
        client,
        credentials,
        runtime,
        desired: ["TERMINATED"],
      });
    } else if (status === "STOPPING") {
      await waitForInstanceLifecycleStatus({
        client,
        credentials,
        runtime,
        desired: ["TERMINATED"],
      });
    }
    const [response] = await client.setMachineType({
      project: credentials.projectId,
      zone: runtime.zone,
      instance: runtime.instance_id,
      instancesSetMachineTypeRequestResource: {
        machineType: `zones/${runtime.zone}/machineTypes/${normalized}`,
      },
    });
    await waitUntilOperationComplete({
      response,
      zone: runtime.zone,
      credentials,
    });
  }

  async probeSpotAvailability(
    spec: HostSpec,
    creds: any,
    opts?: { stableForMs?: number },
  ): Promise<boolean> {
    logger.info("gcp.probeSpotAvailability", {
      region: spec.region,
      zone: spec.zone,
      machine_type: spec.metadata?.machine_type ?? machineTypeFor(spec),
      gpu: spec.gpu?.type ?? "none",
    });
    const credentials = parseCredentials(creds ?? {});
    const client = new InstancesClient(credentials);
    const zone = zoneFor(spec);
    const machineType = `zones/${zone}/machineTypes/${machineTypeFor(spec)}`;
    const diskType = `projects/${credentials.projectId}/zones/${zone}/diskTypes/${diskTypeFor(
      spec,
    )}`;
    const sourceImage = await resolveSourceImage({ spec, credentials });
    const name = [
      "cocalc-spot-probe",
      randomUUID().replace(/-/g, "").slice(0, 20),
    ]
      .join("-")
      .toLowerCase();
    const bootDiskGb =
      spec.metadata?.boot_disk_gb ??
      spec.metadata?.bootDiskGb ??
      (spec.gpu ? 20 : 10);
    const subnetwork =
      `${spec.metadata?.subnetwork_uri ?? ""}`.trim() ||
      `projects/${credentials.projectId}/regions/${spec.region}/subnetworks/default`;
    const networkInterfaces = [
      {
        accessConfigs: [
          {
            name: "External NAT",
            networkTier: "STANDARD",
          },
        ],
        stackType: "IPV4_ONLY",
        subnetwork,
      },
    ];
    const guestAccelerators =
      spec.gpu && !machineTypeFor(spec).startsWith("g2-")
        ? [
            {
              acceleratorCount: Math.max(1, spec.gpu.count ?? 1),
              acceleratorType: `projects/${credentials.projectId}/zones/${zone}/acceleratorTypes/${spec.gpu.type}`,
            },
          ]
        : [];
    try {
      const [response] = await client.insert({
        project: credentials.projectId,
        zone,
        instanceResource: {
          name,
          machineType,
          disks: [
            {
              autoDelete: true,
              boot: true,
              initializeParams: {
                diskSizeGb: `${bootDiskGb}`,
                diskType,
                sourceImage,
              },
            },
          ],
          networkInterfaces,
          guestAccelerators,
          tags: spec.tags ? { items: spec.tags } : undefined,
          scheduling: spotScheduling(),
          labels: spec.metadata?.labels,
          metadata:
            spec.metadata?.block_project_ssh_keys === true
              ? {
                  items: [{ key: "block-project-ssh-keys", value: "TRUE" }],
                }
              : undefined,
          canIpForward: false,
          deletionProtection: false,
          serviceAccounts:
            spec.metadata?.disable_service_account === true ? [] : undefined,
        },
      });
      await waitUntilOperationComplete({
        response,
        zone,
        credentials,
      });
      let remainedStable = true;
      const stableForMs = Math.max(0, opts?.stableForMs ?? 0);
      const stableDeadline = Date.now() + stableForMs;
      while (Date.now() < stableDeadline) {
        const [instance] = await client.get({
          project: credentials.projectId,
          zone,
          instance: name,
        });
        if (instance.status !== "RUNNING") {
          logger.warn("gcp.probeSpotAvailability did not remain running", {
            name,
            zone,
            status: instance.status,
            stableForMs,
          });
          remainedStable = false;
          break;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(10_000, stableDeadline - Date.now())),
        );
      }
      const [deleteResponse] = await client.delete({
        project: credentials.projectId,
        zone,
        instance: name,
      });
      await waitUntilOperationComplete({
        response: deleteResponse,
        zone,
        credentials,
      });
      return remainedStable;
    } catch (err) {
      try {
        const [deleteResponse] = await client.delete({
          project: credentials.projectId,
          zone,
          instance: name,
        });
        await waitUntilOperationComplete({
          response: deleteResponse,
          zone,
          credentials,
        });
      } catch (cleanupErr) {
        if (!isNotFoundError(cleanupErr)) {
          logger.warn("gcp.probeSpotAvailability cleanup failed", {
            name,
            zone,
            cleanupErr: String(cleanupErr),
          });
        }
      }
      logger.warn("gcp.probeSpotAvailability failed", {
        name,
        zone,
        err: String(err),
      });
      return false;
    }
  }

  async hardRestartHost(runtime: HostRuntime, creds: any): Promise<void> {
    logger.info("gcp.hardRestartHost", {
      instance_id: runtime.instance_id,
      zone: runtime.zone,
    });
    const credentials = parseCredentials(creds ?? {});
    if (!runtime.zone) {
      throw new Error("gcp.hardRestartHost requires zone");
    }
    const client = new InstancesClient(credentials);
    const [response] = await client.reset({
      project: credentials.projectId,
      zone: runtime.zone,
      instance: runtime.instance_id,
    });
    await waitUntilOperationComplete({
      response,
      zone: runtime.zone,
      credentials,
    });
  }

  async deleteHost(
    runtime: HostRuntime,
    creds: any,
    opts?: { preserveDataDisk?: boolean },
  ): Promise<void> {
    const credentials = parseCredentials(creds ?? {});
    if (!runtime.zone) {
      throw new Error("gcp.deleteHost requires zone");
    }
    const client = new InstancesClient(credentials);
    const diskClient = new DisksClient(credentials);
    let dataDiskName: string | undefined;
    let scratchDiskName: string | undefined;
    try {
      try {
        const [instance] = await client.get({
          project: credentials.projectId,
          zone: runtime.zone,
          instance: runtime.instance_id,
        });
        const disks = instance?.disks ?? [];
        const metadata = (runtime.metadata ?? {}) as Record<string, any>;
        const scratchNameFromRuntime =
          metadata.shared_disk_name ?? metadata.shared_disk_id;
        const scratchDisk = disks.find((disk) => {
          const name = attachedDiskName(disk);
          return (
            name === scratchNameFromRuntime ||
            `${name ?? ""}`.endsWith("-scratch")
          );
        });
        const dataDisk =
          disks.find(
            (disk) =>
              !disk.boot &&
              disk.type !== "SCRATCH" &&
              attachedDiskName(disk) !== attachedDiskName(scratchDisk),
          ) ??
          disks.find(
            (disk) =>
              !disk.boot &&
              attachedDiskName(disk) !== attachedDiskName(scratchDisk),
          );
        dataDiskName = attachedDiskName(dataDisk);
        scratchDiskName = attachedDiskName(scratchDisk);
        if (opts?.preserveDataDisk && dataDiskName) {
          await client.setDiskAutoDelete({
            project: credentials.projectId,
            zone: runtime.zone,
            instance: runtime.instance_id,
            deviceName: dataDiskName,
            autoDelete: false,
          });
        }
        if (opts?.preserveDataDisk && scratchDiskName) {
          await client.setDiskAutoDelete({
            project: credentials.projectId,
            zone: runtime.zone,
            instance: runtime.instance_id,
            deviceName: scratchDiskName,
            autoDelete: false,
          });
        }
      } catch (err) {
        logger.warn("gcp.deleteHost data disk lookup failed", {
          instance_id: runtime.instance_id,
          zone: runtime.zone,
          err,
        });
      }
      const [response] = await client.delete({
        project: credentials.projectId,
        zone: runtime.zone,
        instance: runtime.instance_id,
      });
      await waitUntilOperationComplete({
        response,
        zone: runtime.zone,
        credentials,
      });
      if (!opts?.preserveDataDisk && dataDiskName) {
        try {
          const [diskResponse] = await diskClient.delete({
            project: credentials.projectId,
            zone: runtime.zone,
            disk: dataDiskName,
          });
          await waitUntilOperationComplete({
            response: diskResponse,
            zone: runtime.zone,
            credentials,
          });
        } catch (err) {
          if (!isNotFoundError(err)) {
            logger.warn("gcp.deleteHost data disk delete failed", {
              instance_id: runtime.instance_id,
              zone: runtime.zone,
              disk: dataDiskName,
              err,
            });
          }
        }
      }
      if (!opts?.preserveDataDisk && scratchDiskName) {
        try {
          const [diskResponse] = await diskClient.delete({
            project: credentials.projectId,
            zone: runtime.zone,
            disk: scratchDiskName,
          });
          await waitUntilOperationComplete({
            response: diskResponse,
            zone: runtime.zone,
            credentials,
          });
        } catch (err) {
          if (!isNotFoundError(err)) {
            logger.warn("gcp.deleteHost shared scratch disk delete failed", {
              instance_id: runtime.instance_id,
              zone: runtime.zone,
              disk: scratchDiskName,
              err,
            });
          }
        }
      }
    } catch (err) {
      if (isNotFoundError(err)) {
        logger.info("gcp.deleteHost: instance already gone", {
          instance_id: runtime.instance_id,
          zone: runtime.zone,
        });
        return;
      }
      throw err;
    }
  }

  async deletePersistentBootDisk(
    runtime: HostRuntime,
    creds: any,
  ): Promise<void> {
    const credentials = parseCredentials(creds ?? {});
    if (!runtime.zone) {
      throw new Error("gcp.deletePersistentBootDisk requires zone");
    }
    const diskName = `${runtime.metadata?.boot_disk_name ?? ""}`.trim();
    if (!diskName) {
      throw new Error("gcp.deletePersistentBootDisk requires boot_disk_name");
    }
    const diskClient = new DisksClient(credentials);
    try {
      const [response] = await diskClient.delete({
        project: credentials.projectId,
        zone: runtime.zone,
        disk: diskName,
      });
      await waitUntilOperationComplete({
        response,
        zone: runtime.zone,
        credentials,
      });
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
  }

  async ensurePersistentDisk(
    opts: {
      name: string;
      zone: string;
      size_gb: number;
      disk_type: "balanced";
      labels?: Record<string, string>;
    },
    creds: any,
  ): Promise<{ name: string; uri: string; size_gb: number; users: string[] }> {
    const credentials = parseCredentials(creds ?? {});
    const client = new DisksClient(credentials);
    let disk: any;
    try {
      [disk] = await client.get({
        project: credentials.projectId,
        zone: opts.zone,
        disk: opts.name,
      });
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      try {
        const [response] = await client.insert({
          project: credentials.projectId,
          zone: opts.zone,
          diskResource: {
            name: opts.name,
            sizeGb: `${Math.floor(opts.size_gb)}`,
            type: `projects/${credentials.projectId}/zones/${opts.zone}/diskTypes/pd-balanced`,
            labels: opts.labels,
          },
        } as any);
        await waitUntilOperationComplete({
          response,
          zone: opts.zone,
          credentials,
        });
      } catch (insertErr) {
        // A VM provision and the independent volume reconciler may both prove
        // the same durable disk concurrently. Provider identity makes the
        // resulting AlreadyExists response an idempotent success.
        if (!isAlreadyExistsError(insertErr)) throw insertErr;
      }
      [disk] = await client.get({
        project: credentials.projectId,
        zone: opts.zone,
        disk: opts.name,
      });
    }
    return {
      name: opts.name,
      uri:
        disk?.selfLink ??
        `projects/${credentials.projectId}/zones/${opts.zone}/disks/${opts.name}`,
      size_gb: Number(disk?.sizeGb ?? opts.size_gb),
      users: Array.isArray(disk?.users)
        ? disk.users.map((user) => `${user}`)
        : [],
    };
  }

  async inspectPersistentDisk(
    opts: { name: string; zone: string },
    creds: any,
  ): Promise<
    { name: string; uri: string; size_gb: number; users: string[] } | undefined
  > {
    const credentials = parseCredentials(creds ?? {});
    const client = new DisksClient(credentials);
    try {
      const [disk] = await client.get({
        project: credentials.projectId,
        zone: opts.zone,
        disk: opts.name,
      });
      return {
        name: opts.name,
        uri:
          disk?.selfLink ??
          `projects/${credentials.projectId}/zones/${opts.zone}/disks/${opts.name}`,
        size_gb: Number(disk?.sizeGb ?? 0),
        users: Array.isArray(disk?.users)
          ? disk.users.map((user) => `${user}`)
          : [],
      };
    } catch (err) {
      if (isNotFoundError(err)) return undefined;
      throw err;
    }
  }

  async resizePersistentDisk(
    opts: { name: string; zone: string; size_gb: number },
    creds: any,
  ): Promise<void> {
    const credentials = parseCredentials(creds ?? {});
    const client = new DisksClient(credentials);
    const [response] = await client.resize({
      project: credentials.projectId,
      zone: opts.zone,
      disk: opts.name,
      disksResizeRequestResource: { sizeGb: Math.floor(opts.size_gb) },
    });
    await waitUntilOperationComplete({
      response,
      zone: opts.zone,
      credentials,
    });
  }

  async deletePersistentDisk(
    opts: { name: string; zone: string },
    creds: any,
  ): Promise<void> {
    const observed = await this.inspectPersistentDisk(opts, creds);
    if (!observed) return;
    if (observed.users.length) {
      throw new Error(
        `gcp: refusing to delete attached disk '${opts.name}' (${observed.users.join(", ")})`,
      );
    }
    const credentials = parseCredentials(creds ?? {});
    const client = new DisksClient(credentials);
    try {
      const [response] = await client.delete({
        project: credentials.projectId,
        zone: opts.zone,
        disk: opts.name,
      });
      await waitUntilOperationComplete({
        response,
        zone: opts.zone,
        credentials,
      });
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
  }

  async resizeDisk(
    runtime: HostRuntime,
    newSizeGb: number,
    creds: any,
  ): Promise<number> {
    const credentials = parseCredentials(creds ?? {});
    if (!runtime.zone) {
      throw new Error("gcp.resizeDisk requires zone");
    }
    const diskClient = new DisksClient(credentials);
    const instanceClient = new InstancesClient(credentials);
    const runtimeMetadata = runtime.metadata as
      | { data_disk_name?: string; data_disk_uri?: string }
      | undefined;
    let diskName = runtimeMetadata?.data_disk_name;
    if (!diskName && runtimeMetadata?.data_disk_uri) {
      diskName = runtimeMetadata.data_disk_uri.split("/").pop();
    }
    if (!diskName) {
      const [instance] = await instanceClient.get({
        project: credentials.projectId,
        zone: runtime.zone,
        instance: runtime.instance_id,
      });
      const disks = instance?.disks ?? [];
      const dataDisk =
        disks.find((disk) => !disk.boot && disk.type !== "SCRATCH") ??
        disks.find((disk) => !disk.boot) ??
        disks[0];
      const source = dataDisk?.source ?? "";
      diskName = source.split("/").pop();
    }
    if (!diskName) {
      throw new Error("gcp.resizeDisk could not determine disk name");
    }
    const targetSizeGb = Math.max(1, Math.ceil(newSizeGb));
    const getObservedSizeGb = async (): Promise<number | undefined> => {
      const [disk] = await diskClient.get({
        project: credentials.projectId,
        zone: runtime.zone,
        disk: diskName,
      });
      const sizeGb = Number(disk?.sizeGb);
      return Number.isFinite(sizeGb) && sizeGb > 0 ? sizeGb : undefined;
    };
    const currentSizeGb = await getObservedSizeGb();
    if (currentSizeGb != null && currentSizeGb >= targetSizeGb) {
      return currentSizeGb;
    }
    const [response] = await diskClient.resize({
      project: credentials.projectId,
      zone: runtime.zone,
      disk: diskName,
      disksResizeRequestResource: { sizeGb: targetSizeGb },
    });
    await waitUntilOperationComplete({
      response,
      zone: runtime.zone,
      credentials,
    });
    const observedSizeGb = await getObservedSizeGb();
    if (observedSizeGb != null && observedSizeGb < targetSizeGb) {
      throw new Error(
        `gcp.resizeDisk did not reach requested size ${targetSizeGb} GiB; provider reports ${observedSizeGb} GiB`,
      );
    }
    return observedSizeGb ?? targetSizeGb;
  }

  async resizeSharedScratchDisk(
    runtime: HostRuntime,
    newSizeGb: number,
    creds: any,
  ): Promise<void> {
    const credentials = parseCredentials(creds ?? {});
    if (!runtime.zone) {
      throw new Error("gcp.resizeSharedScratchDisk requires zone");
    }
    const diskName = await resolveSharedScratchDiskName({
      runtime,
      credentials,
    });
    const diskClient = new DisksClient(credentials);
    const [response] = await diskClient.resize({
      project: credentials.projectId,
      zone: runtime.zone,
      disk: diskName,
      disksResizeRequestResource: { sizeGb: Math.floor(newSizeGb) },
    });
    await waitUntilOperationComplete({
      response,
      zone: runtime.zone,
      credentials,
    });
  }

  async ensureSharedScratchDisk(
    runtime: HostRuntime,
    spec: HostSpec,
    creds: any,
  ): Promise<HostRuntime> {
    const credentials = parseCredentials(creds ?? {});
    if (!runtime.zone) {
      throw new Error("gcp.ensureSharedScratchDisk requires zone");
    }
    const zone = runtime.zone;
    const diskClient = new DisksClient(credentials);
    const instanceClient = new InstancesClient(credentials) as any;
    const sharedDiskGb = Number(spec.shared_disk_gb ?? 0);
    if (!Number.isFinite(sharedDiskGb) || sharedDiskGb <= 0) {
      throw new Error("gcp: shared scratch disk size is required");
    }
    const diskName =
      spec.metadata?.shared_disk_name ??
      (runtime.metadata as any)?.shared_disk_name ??
      (runtime.metadata as any)?.shared_disk_id ??
      `${spec.name}-scratch`;
    const diskType = `projects/${credentials.projectId}/zones/${zone}/diskTypes/${sharedScratchDiskTypeFor(
      spec,
    )}`;
    let diskSource: string | undefined;
    try {
      const [disk] = await diskClient.get({
        project: credentials.projectId,
        zone,
        disk: diskName,
      });
      diskSource = disk?.selfLink ?? undefined;
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      const [response] = await diskClient.insert({
        project: credentials.projectId,
        zone,
        diskResource: {
          name: diskName,
          sizeGb: `${Math.floor(sharedDiskGb)}`,
          type: diskType,
        },
      } as any);
      await waitUntilOperationComplete({ response, zone, credentials });
      const [disk] = await diskClient.get({
        project: credentials.projectId,
        zone,
        disk: diskName,
      });
      diskSource =
        disk?.selfLink ??
        `projects/${credentials.projectId}/zones/${zone}/disks/${diskName}`;
    }
    const [instance] = await instanceClient.get({
      project: credentials.projectId,
      zone,
      instance: runtime.instance_id,
    });
    const disks = instance?.disks ?? [];
    const attached = disks.some((disk) => attachedDiskName(disk) === diskName);
    if (!attached) {
      const [response] = await instanceClient.attachDisk({
        project: credentials.projectId,
        zone,
        instance: runtime.instance_id,
        attachedDiskResource: {
          autoDelete: false,
          boot: false,
          deviceName: diskName,
          source:
            diskSource ??
            `projects/${credentials.projectId}/zones/${zone}/disks/${diskName}`,
        },
      });
      await waitUntilOperationComplete({ response, zone, credentials });
    }
    return {
      ...runtime,
      metadata: {
        ...(runtime.metadata ?? {}),
        shared_disk_gb: Math.floor(sharedDiskGb),
        shared_disk_type: spec.shared_disk_type ?? "balanced",
        shared_disk_id: diskName,
        shared_disk_name: diskName,
        shared_disk_uri:
          diskSource ??
          `projects/${credentials.projectId}/zones/${zone}/disks/${diskName}`,
      },
    };
  }

  async deleteSharedScratchDisk(
    runtime: HostRuntime,
    creds: any,
  ): Promise<void> {
    const credentials = parseCredentials(creds ?? {});
    if (!runtime.zone) {
      throw new Error("gcp.deleteSharedScratchDisk requires zone");
    }
    const diskName = await resolveSharedScratchDiskName({
      runtime,
      credentials,
    });
    const instanceClient = new InstancesClient(credentials) as any;
    try {
      const [instance] = await instanceClient.get({
        project: credentials.projectId,
        zone: runtime.zone,
        instance: runtime.instance_id,
      });
      const attached = (instance?.disks ?? []).some(
        (disk) => attachedDiskName(disk) === diskName,
      );
      if (attached) {
        const [response] = await instanceClient.detachDisk({
          project: credentials.projectId,
          zone: runtime.zone,
          instance: runtime.instance_id,
          deviceName: diskName,
        });
        await waitUntilOperationComplete({
          response,
          zone: runtime.zone,
          credentials,
        });
      }
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
    const diskClient = new DisksClient(credentials);
    try {
      const [response] = await diskClient.delete({
        project: credentials.projectId,
        zone: runtime.zone,
        disk: diskName,
      });
      await waitUntilOperationComplete({
        response,
        zone: runtime.zone,
        credentials,
      });
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
  }

  async getStatus(
    runtime: HostRuntime,
    creds: any,
  ): Promise<"starting" | "running" | "stopped" | "error"> {
    const credentials = parseCredentials(creds ?? {});
    const client = new InstancesClient(credentials);
    const [response] = await client.get({
      project: credentials.projectId,
      zone: runtime.zone,
      instance: runtime.instance_id,
    });
    const status = response?.status ?? "UNKNOWN";
    if (status === "RUNNING") return "running";
    if (status === "TERMINATED") return "stopped";
    if (status === "PROVISIONING" || status === "STAGING") return "starting";
    if (status === "STOPPING") return "stopped";
    return "error";
  }

  async listInstances(
    creds: any,
    opts?: { namePrefix?: string },
  ): Promise<RemoteInstance[]> {
    const credentials = parseCredentials(creds ?? {});
    const client = new InstancesClient(credentials);
    const instances: RemoteInstance[] = [];
    for await (const [zoneName, scopedList] of client.aggregatedListAsync({
      project: credentials.projectId,
    })) {
      const zone = (zoneName ?? "").split("/").pop();
      const entries = scopedList?.instances ?? [];
      for (const inst of entries) {
        const name = inst.name ?? "";
        if (opts?.namePrefix && !name.startsWith(opts.namePrefix)) continue;
        const public_ip =
          inst?.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP ?? undefined;
        const private_ip = inst?.networkInterfaces?.[0]?.networkIP ?? undefined;
        instances.push({
          instance_id: name,
          name,
          status: inst.status ?? undefined,
          zone,
          public_ip,
          private_ip,
          internal_hostname: gcpInternalHostname({
            configuredHostname: inst.hostname,
            instanceName: name,
            projectId: credentials.projectId,
          }),
        });
      }
    }
    return instances;
  }

  async getInstance(
    runtime: HostRuntime,
    creds: any,
  ): Promise<RemoteInstance | undefined> {
    const credentials = parseCredentials(creds ?? {});
    if (!runtime.zone) return undefined;
    const client = new InstancesClient(credentials);
    const [instance] = await client.get({
      project: credentials.projectId,
      zone: runtime.zone,
      instance: runtime.instance_id,
    });
    if (!instance) return undefined;
    const public_ip =
      instance?.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP ?? undefined;
    const private_ip = instance?.networkInterfaces?.[0]?.networkIP ?? undefined;
    const networkInterface = instance?.networkInterfaces?.[0];
    const metadataItems = instance?.metadata?.items ?? [];
    const blockProjectSshKeys = metadataItems.find(
      (item) => item.key === "block-project-ssh-keys",
    )?.value;
    return {
      instance_id: runtime.instance_id,
      name: instance.name ?? runtime.instance_id,
      status: instance.status ?? undefined,
      zone: runtime.zone,
      public_ip,
      private_ip,
      internal_hostname: gcpInternalHostname({
        configuredHostname: instance.hostname,
        instanceName: instance.name ?? runtime.instance_id,
        projectId: credentials.projectId,
      }),
      metadata: {
        gcp_instance_id: instance.id?.toString(),
        machine_type: `${instance.machineType ?? ""}`.split("/").pop(),
        pricing_model: pricingModelFromInstance(instance),
        provider_status: instance.status ?? undefined,
        gcp_security: {
          service_account_count: instance?.serviceAccounts?.length ?? 0,
          can_ip_forward: instance?.canIpForward === true,
          deletion_protection: instance?.deletionProtection === true,
          block_project_ssh_keys:
            `${blockProjectSshKeys ?? ""}`.toUpperCase() === "TRUE",
          tags: instance?.tags?.items ?? [],
          subnetwork: networkInterface?.subnetwork,
          external_access_config_count:
            networkInterface?.accessConfigs?.length ?? 0,
          network_tier: networkInterface?.accessConfigs?.[0]?.networkTier,
          external_ipv6:
            (networkInterface?.ipv6AccessConfigs?.length ?? 0) > 0 ||
            !!networkInterface?.ipv6Address,
        },
      },
    };
  }
}

async function ensureSshMetadata(
  runtime: HostRuntime,
  credentials: { projectId: string; credentials: any },
  client: InstancesClient,
): Promise<void> {
  const sshPublicKeys = normalizeSshKeys(
    runtime.metadata?.ssh_public_keys,
    runtime.metadata?.ssh_public_key,
  );
  if (!sshPublicKeys.length) return;
  const zone = runtime.zone;
  if (!zone) return;
  const sshUser = runtime.metadata?.ssh_user ?? "ubuntu";
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const [instance] = await client.get({
        project: credentials.projectId,
        zone,
        instance: runtime.instance_id,
      });
      const fingerprint = instance?.metadata?.fingerprint;
      if (!fingerprint) return;
      const items = instance?.metadata?.items ?? [];
      const current = items.find((item) => item.key === "ssh-keys");
      const replaceManagedKeys =
        runtime.metadata?.replace_managed_ssh_keys === true;
      const nextLines = new Set(
        (current?.value ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter(
            (line) =>
              !!line &&
              (!replaceManagedKeys || !line.startsWith(`${sshUser}:`)),
          ),
      );
      for (const key of sshPublicKeys) {
        nextLines.add(`${sshUser}:${key}`);
      }
      const nextValue = Array.from(nextLines).join("\n");
      if ((current?.value ?? "") === nextValue) return;
      const nextItems = items.filter((item) => item.key !== "ssh-keys");
      nextItems.push({ key: "ssh-keys", value: nextValue });
      const [response] = await client.setMetadata({
        project: credentials.projectId,
        zone,
        instance: runtime.instance_id,
        metadataResource: {
          fingerprint,
          items: nextItems,
        },
      });
      await waitUntilOperationComplete({
        response,
        zone,
        credentials,
      });
      return;
    } catch (err) {
      const retryable =
        isFingerprintConflictError(err) && attempt < maxAttempts;
      if (!retryable) throw err;
      logger.warn("gcp.ensureSshMetadata retry after fingerprint conflict", {
        instance_id: runtime.instance_id,
        zone,
        attempt,
        err: String(err),
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

async function ensureStartupScriptMetadata(
  runtime: HostRuntime,
  credentials: { projectId: string; credentials: any },
  client: InstancesClient,
): Promise<void> {
  const startupScript = `${runtime.metadata?.startup_script ?? ""}`;
  if (!startupScript) return;
  const zone = runtime.zone;
  if (!zone) return;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const [instance] = await client.get({
        project: credentials.projectId,
        zone,
        instance: runtime.instance_id,
      });
      const fingerprint = instance?.metadata?.fingerprint;
      if (!fingerprint) return;
      const items = instance?.metadata?.items ?? [];
      const current = items.find((item) => item.key === "startup-script");
      if ((current?.value ?? "") === startupScript) return;
      const nextItems = items.filter((item) => item.key !== "startup-script");
      nextItems.push({ key: "startup-script", value: startupScript });
      const [response] = await client.setMetadata({
        project: credentials.projectId,
        zone,
        instance: runtime.instance_id,
        metadataResource: {
          fingerprint,
          items: nextItems,
        },
      });
      await waitUntilOperationComplete({
        response,
        zone,
        credentials,
      });
      return;
    } catch (err) {
      const retryable =
        isFingerprintConflictError(err) && attempt < maxAttempts;
      if (!retryable) throw err;
      logger.warn(
        "gcp.ensureStartupScriptMetadata retry after fingerprint conflict",
        {
          instance_id: runtime.instance_id,
          zone,
          attempt,
          err: String(err),
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

function normalizeSshKeys(
  raw?: string[] | string,
  fallback?: string,
): string[] {
  const items: string[] = [];
  if (Array.isArray(raw)) {
    items.push(...raw);
  } else if (typeof raw === "string") {
    items.push(...raw.split(/\r?\n|,/g));
  }
  if (fallback) items.push(fallback);
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const entry of items) {
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    cleaned.push(trimmed);
  }
  return cleaned;
}
