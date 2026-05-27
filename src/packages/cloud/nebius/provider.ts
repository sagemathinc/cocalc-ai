import type {
  CloudProvider,
  HostRuntime,
  HostSpec,
  RemoteInstance,
} from "../types";
import getLogger from "@cocalc/backend/logger";
import { NebiusClient, type NebiusCreds } from "./client";
import {
  AttachedDiskSpec,
  AttachedDiskSpec_AttachMode,
  CreateDiskRequest,
  CreateInstanceRequest,
  DeleteDiskRequest,
  DeleteInstanceRequest,
  DiskSpec,
  DiskSpec_DiskType,
  ExistingDisk,
  GetDiskRequest,
  GetInstanceRequest,
  InstanceRecoveryPolicy,
  InstanceSpec,
  InstanceStatus_InstanceState,
  IPAddress,
  ListDisksRequest,
  ListInstancesRequest,
  NetworkInterfaceSpec,
  PreemptibleSpec,
  PreemptibleSpec_PreemptionPolicy,
  PublicIPAddress,
  ResourcesSpec,
  SourceImageFamily,
  StartInstanceRequest,
  StopInstanceRequest,
  UpdateDiskRequest,
  UpdateInstanceRequest,
} from "@nebius/js-sdk/api/nebius/compute/v1/index";
import { ResourceMetadata } from "@nebius/js-sdk/api/nebius/common/v1/index";
import { Long } from "@nebius/js-sdk/runtime/protos/index";

const logger = getLogger("cloud:nebius:provider");

type NebiusRuntimeMeta = {
  diskIds?: {
    boot?: string;
    data?: string;
    scratch?: string;
  };
  diskTypeCode?: number;
  scratchDiskTypeCode?: number;
  subnetId?: string;
};

const DISK_DELETE_MAX_ATTEMPTS = 12;
const DISK_DELETE_RETRY_DELAY_MS = 5000;

function sanitizeName(base: string, maxLen = 63): string {
  const clean = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
  let safeBase = clean(base);
  if (!safeBase) return "cocalc";
  if (safeBase.length > maxLen) {
    safeBase = safeBase.slice(0, maxLen).replace(/-+$/g, "");
  }
  return safeBase || "cocalc";
}

function diskTypeFor(spec: HostSpec): DiskSpec_DiskType {
  if (spec.disk_type === "standard") return DiskSpec_DiskType.NETWORK_HDD;
  if (spec.disk_type === "balanced") {
    return DiskSpec_DiskType.NETWORK_SSD_NON_REPLICATED;
  }
  if (spec.disk_type === "ssd_io_m3") {
    return DiskSpec_DiskType.NETWORK_SSD_IO_M3;
  }
  return DiskSpec_DiskType.NETWORK_SSD;
}

function sharedScratchDiskTypeFor(spec: HostSpec): DiskSpec_DiskType {
  switch (spec.shared_disk_type) {
    case "balanced":
      return DiskSpec_DiskType.NETWORK_SSD_NON_REPLICATED;
    case "ssd_io_m3":
      return DiskSpec_DiskType.NETWORK_SSD_IO_M3;
    case "standard":
      return DiskSpec_DiskType.NETWORK_HDD;
    case "ssd":
    default:
      return DiskSpec_DiskType.NETWORK_SSD;
  }
}

const NEBIUS_DISK_INCREMENT_GIB = 93;

function normalizeDiskSizeGib(sizeGib: number): {
  sizeGib: number;
  adjusted: boolean;
} {
  const min = NEBIUS_DISK_INCREMENT_GIB;
  const rounded =
    sizeGib <= min
      ? min
      : Math.ceil(sizeGib / NEBIUS_DISK_INCREMENT_GIB) *
        NEBIUS_DISK_INCREMENT_GIB;
  return { sizeGib: rounded, adjusted: rounded !== sizeGib };
}

function blockSizeBytes(): Long {
  return Long.fromNumber(4096);
}

function diskTypeFromCode(code?: number): DiskSpec_DiskType {
  if (code == null) return DiskSpec_DiskType.NETWORK_SSD;
  return DiskSpec_DiskType.fromNumber(code);
}

async function updateDiskSize({
  client,
  diskId,
  diskType,
  sizeGib,
  fallbackName,
}: {
  client: NebiusClient;
  diskId: string;
  diskType: DiskSpec_DiskType;
  sizeGib: number;
  fallbackName?: string;
}) {
  const disk = await client.disks.get(GetDiskRequest.create({ id: diskId }));
  const name = `${disk?.metadata?.name ?? fallbackName ?? ""}`.trim();
  const op = await client.disks.update(
    UpdateDiskRequest.create({
      metadata: ResourceMetadata.create({
        id: diskId,
        ...(name ? { name } : {}),
      }),
      spec: DiskSpec.create({
        type: diskType,
        blockSizeBytes: blockSizeBytes(),
        size: {
          $case: "sizeGibibytes",
          sizeGibibytes: Long.fromNumber(sizeGib),
        },
      }),
    }),
  );
  await op.wait();
}

function normalizeIp(value?: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const [ip] = trimmed.split("/");
  return ip || undefined;
}

function isAlreadyExistsError(err: unknown): boolean {
  const message = String((err as any)?.message ?? err);
  const code = (err as any)?.code;
  return (
    message.includes("ALREADY_EXISTS") ||
    message.toLowerCase().includes("already exists") ||
    code === "ALREADY_EXISTS" ||
    code === 6
  );
}

function isNotFoundError(err: unknown): boolean {
  const message = String((err as any)?.message ?? err);
  const code = (err as any)?.code;
  return (
    message.includes("NOT_FOUND") ||
    message.includes("ResourceNotFound") ||
    message.toLowerCase().includes("not found") ||
    code === "NOT_FOUND" ||
    code === 5
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDiskDeletionBlockedByError(err: unknown): boolean {
  const message = String((err as any)?.message ?? err).toLowerCase();
  return (
    message.includes("attached") ||
    message.includes("attachment") ||
    message.includes("reconcil") ||
    message.includes("lock") ||
    message.includes("busy") ||
    message.includes("in use")
  );
}

async function waitForDiskToDetach(
  client: NebiusClient,
  diskId: string,
  instanceId: string | undefined,
): Promise<"ready" | "missing"> {
  for (let attempt = 1; attempt <= DISK_DELETE_MAX_ATTEMPTS; attempt += 1) {
    let disk;
    try {
      disk = await client.disks.get(GetDiskRequest.create({ id: diskId }));
    } catch (err) {
      if (isNotFoundError(err)) return "missing";
      throw err;
    }
    const status = disk.status;
    const attachedTo = status?.readWriteAttachment ?? "";
    const locked = !!status?.lockState?.images?.length;
    const reconciling = !!status?.reconciling;
    const attached =
      attachedTo.length > 0 &&
      (!instanceId || attachedTo === instanceId || attachedTo.length > 0);
    if (!attached && !reconciling && !locked) {
      return "ready";
    }
    logger.info("nebius: waiting for disk to become deletable", {
      diskId,
      attempt,
      attachedTo: attachedTo || undefined,
      reconciling,
      locked_images: status?.lockState?.images?.length ?? 0,
    });
    if (attempt < DISK_DELETE_MAX_ATTEMPTS) {
      await delay(DISK_DELETE_RETRY_DELAY_MS);
    }
  }
  return "ready";
}

async function deleteDiskWithRetry(
  client: NebiusClient,
  diskId: string,
  instanceId: string | undefined,
): Promise<void> {
  const readiness = await waitForDiskToDetach(client, diskId, instanceId);
  if (readiness === "missing") return;
  let lastError: unknown;
  for (let attempt = 1; attempt <= DISK_DELETE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const diskOp = await client.disks.delete(
        DeleteDiskRequest.create({ id: diskId }),
      );
      await diskOp.wait();
      return;
    } catch (err) {
      if (isNotFoundError(err)) return;
      lastError = err;
      logger.warn("nebius: disk delete attempt failed", {
        diskId,
        attempt,
        err,
      });
      if (
        attempt < DISK_DELETE_MAX_ATTEMPTS &&
        isDiskDeletionBlockedByError(err)
      ) {
        await delay(DISK_DELETE_RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`nebius: failed deleting disk ${diskId}`);
}

async function findDiskIdByName(
  client: NebiusClient,
  parentId: string,
  name: string,
): Promise<string | undefined> {
  let pageToken = "";
  for (;;) {
    const res = await client.disks.list(
      ListDisksRequest.create({
        parentId,
        pageSize: Long.fromNumber(999),
        pageToken,
      }),
    );
    const match = (res.items ?? []).find(
      (disk) =>
        (disk.metadata?.name ?? "").toLowerCase() === name.toLowerCase(),
    );
    if (match?.metadata?.id) return match.metadata.id;
    const nextToken = res.nextPageToken ?? "";
    if (!nextToken) return undefined;
    pageToken = nextToken;
  }
}

async function createDiskOrReuse(
  client: NebiusClient,
  parentId: string,
  name: string,
  spec: DiskSpec,
): Promise<string> {
  try {
    const op = await client.disks.create(
      CreateDiskRequest.create({
        metadata: ResourceMetadata.create({ parentId, name }),
        spec,
      }),
    );
    await op.wait();
    return op.resourceId();
  } catch (err) {
    if (!isAlreadyExistsError(err)) throw err;
    const existingId = await findDiskIdByName(client, parentId, name);
    if (!existingId) {
      logger.warn("nebius: disk already exists but not found", {
        name,
        parentId,
        err,
      });
      throw err;
    }
    logger.info("nebius: reusing existing disk", { name, diskId: existingId });
    return existingId;
  }
}

function buildUserData(spec: HostSpec): string | undefined {
  const direct = spec.metadata?.user_data;
  if (direct) return direct;
  const script = spec.metadata?.startup_script;
  if (script) return script;
  const url = spec.metadata?.bootstrap_url;
  if (!url) return undefined;
  return `#!/bin/bash\nset -e\ncurl -fsSL ${url} | bash`;
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

export type NebiusProviderCreds = NebiusCreds & {
  sshPublicKey: string;
  prefix?: string;
  subnetId?: string;
};

export class NebiusProvider implements CloudProvider {
  private routingCodeFromId(id?: string): string | undefined {
    if (!id) return undefined;
    const match = id.match(/^[a-z]+-([a-z0-9]{3})/i);
    return match?.[1];
  }

  mapStatus(status?: string): string | undefined {
    if (!status) return undefined;
    const normalized = status.toLowerCase();
    if (normalized.includes("running")) return "running";
    if (normalized.includes("stopping") || normalized.includes("deleting"))
      return "stopping";
    if (normalized.includes("starting")) return "starting";
    if (normalized.includes("stopped")) return "off";
    return undefined;
  }

  async createHost(
    spec: HostSpec,
    creds: NebiusProviderCreds,
  ): Promise<HostRuntime> {
    const client = new NebiusClient(creds);
    const parentId = creds.parentId;
    if (!parentId) {
      throw new Error("nebius parentId is required");
    }
    const name = sanitizeName(spec.name, 63);
    const subnetId =
      spec.metadata?.subnet_id ??
      spec.metadata?.nebius_subnet_id ??
      creds.subnetId;
    if (!subnetId) {
      throw new Error("nebius subnetId is required");
    }
    const serviceAccountId =
      spec.metadata?.service_account_id ??
      spec.metadata?.serviceAccountId ??
      spec.metadata?.nebius_service_account_id;
    let sourceImage =
      spec.metadata?.source_image ??
      spec.metadata?.image_id ??
      spec.metadata?.image;
    const sourceImageFamily =
      spec.metadata?.source_image_family ?? spec.metadata?.image_family;
    const routingCode =
      this.routingCodeFromId(subnetId) ?? this.routingCodeFromId(parentId);
    const imageRouting = this.routingCodeFromId(sourceImage);
    if (
      sourceImage &&
      routingCode &&
      imageRouting &&
      routingCode !== imageRouting
    ) {
      logger.warn("nebius: source image routing code mismatch; using family", {
        source_image: sourceImage,
        source_image_family: sourceImageFamily,
        routing_code: routingCode,
        image_routing: imageRouting,
        parentId,
        subnetId,
      });
      sourceImage = undefined;
    }
    logger.debug("nebius: source image selection", {
      source_image: sourceImage,
      source_image_family: sourceImageFamily,
      metadata_source_image: spec.metadata?.source_image,
      metadata_image_id: spec.metadata?.image_id,
      metadata_image: spec.metadata?.image,
      metadata_source_image_family: spec.metadata?.source_image_family,
      metadata_image_family: spec.metadata?.image_family,
    });
    if (!sourceImage && !sourceImageFamily) {
      throw new Error("nebius source_image or source_image_family is required");
    }

    const bootDiskGb =
      spec.metadata?.boot_disk_gb ??
      spec.metadata?.bootDiskGb ??
      (spec.gpu ? 20 : 10);

    const bootDiskType = DiskSpec_DiskType.NETWORK_SSD;
    const dataDiskType = diskTypeFor(spec);
    const diskIds: NebiusRuntimeMeta["diskIds"] = {};

    logger.info("nebius: creating boot disk", {
      name,
      size_gb: bootDiskGb,
      type: bootDiskType,
    });
    const bootDiskName = `${name}-boot`;
    diskIds.boot = await createDiskOrReuse(
      client,
      parentId,
      bootDiskName,
      DiskSpec.create({
        type: bootDiskType,
        blockSizeBytes: blockSizeBytes(),
        size: {
          $case: "sizeGibibytes",
          sizeGibibytes: Long.fromNumber(bootDiskGb),
        },
        source: sourceImage
          ? { $case: "sourceImageId", sourceImageId: sourceImage }
          : {
              $case: "sourceImageFamily",
              sourceImageFamily: SourceImageFamily.create({
                imageFamily: sourceImageFamily!,
              }),
            },
      }),
    );

    const storageMode = spec.metadata?.storage_mode;
    if (storageMode === "persistent") {
      const existingDataDiskId =
        spec.metadata?.data_disk_id ?? spec.metadata?.dataDiskId ?? undefined;
      const normalized = normalizeDiskSizeGib(spec.disk_gb);
      if (normalized.adjusted) {
        logger.info("nebius: adjusting data disk size to provider increment", {
          name,
          from_gb: spec.disk_gb,
          to_gb: normalized.sizeGib,
        });
      }
      logger.info("nebius: creating data disk", {
        name,
        size_gb: normalized.sizeGib,
        type: dataDiskType,
      });
      const dataDiskName = `${name}-data`;
      if (existingDataDiskId) {
        diskIds.data = existingDataDiskId;
      } else {
        diskIds.data = await createDiskOrReuse(
          client,
          parentId,
          dataDiskName,
          DiskSpec.create({
            type: dataDiskType,
            blockSizeBytes: blockSizeBytes(),
            size: {
              $case: "sizeGibibytes",
              sizeGibibytes: Long.fromNumber(normalized.sizeGib),
            },
          }),
        );
      }
    }
    const sharedDiskGb = Number(spec.shared_disk_gb ?? 0);
    const wantsSharedScratch =
      Number.isFinite(sharedDiskGb) && sharedDiskGb > 0;
    let scratchDiskType: DiskSpec_DiskType | undefined;
    if (wantsSharedScratch) {
      const existingScratchDiskId =
        spec.metadata?.shared_disk_id ??
        spec.metadata?.sharedDiskId ??
        undefined;
      scratchDiskType = sharedScratchDiskTypeFor(spec);
      const normalized = normalizeDiskSizeGib(sharedDiskGb);
      if (normalized.adjusted) {
        logger.info(
          "nebius: adjusting shared scratch disk size to provider increment",
          {
            name,
            from_gb: sharedDiskGb,
            to_gb: normalized.sizeGib,
          },
        );
      }
      logger.info("nebius: creating shared scratch disk", {
        name,
        size_gb: normalized.sizeGib,
        type: scratchDiskType,
      });
      const scratchDiskName =
        spec.metadata?.shared_disk_name ?? `${name}-scratch`;
      if (existingScratchDiskId) {
        diskIds.scratch = existingScratchDiskId;
      } else {
        diskIds.scratch = await createDiskOrReuse(
          client,
          parentId,
          scratchDiskName,
          DiskSpec.create({
            type: scratchDiskType,
            blockSizeBytes: blockSizeBytes(),
            size: {
              $case: "sizeGibibytes",
              sizeGibibytes: Long.fromNumber(normalized.sizeGib),
            },
          }),
        );
      }
    }

    const userData = buildUserData(spec) ?? "";
    const sshKeys = normalizeSshKeys(
      spec.metadata?.ssh_public_keys,
      creds.sshPublicKey,
    );
    const cloudInit = [
      "#cloud-config",
      "users:",
      "  - name: ubuntu",
      "    sudo: ALL=(ALL) NOPASSWD:ALL",
      "    shell: /bin/bash",
      "    ssh_authorized_keys:",
      ...sshKeys.map((key) => `      - ${key}`),
      userData ? "runcmd:" : "",
      userData ? `  - [ bash, -lc, ${JSON.stringify(userData)} ]` : "",
    ]
      .filter((line) => line !== "")
      .join("\n");

    logger.info("nebius: creating instance", { name, subnetId });
    logger.debug("nebius: network interface", {
      subnetId,
      privateIp: "auto",
      publicIp: true,
    });
    const machineType = spec.metadata?.machine_type;
    if (!machineType) {
      throw new Error("nebius machine_type is required");
    }
    const platform = spec.metadata?.platform;
    if (!platform) {
      throw new Error("nebius platform is required");
    }

    const createOp = await client.instances.create(
      CreateInstanceRequest.create({
        metadata: ResourceMetadata.create({
          parentId,
          name,
        }),
        spec: InstanceSpec.create({
          ...(serviceAccountId ? { serviceAccountId } : {}),
          resources: ResourcesSpec.create({
            platform,
            size: { $case: "preset", preset: machineType },
          }),
          networkInterfaces: [
            NetworkInterfaceSpec.create({
              subnetId,
              name: "eth0",
              // Nebius requires ipAddress to be present even when auto-assigning.
              ipAddress: IPAddress.create({}),
              publicIpAddress: PublicIPAddress.create({ static: true }),
              aliases: [],
            }),
          ],
          bootDisk: AttachedDiskSpec.create({
            attachMode: AttachedDiskSpec_AttachMode.READ_WRITE,
            deviceId: "boot",
            type: {
              $case: "existingDisk",
              existingDisk: ExistingDisk.create({ id: diskIds.boot! }),
            },
          }),
          secondaryDisks: [
            ...(diskIds.data
              ? [
                  AttachedDiskSpec.create({
                    attachMode: AttachedDiskSpec_AttachMode.READ_WRITE,
                    deviceId: "data",
                    type: {
                      $case: "existingDisk",
                      existingDisk: ExistingDisk.create({ id: diskIds.data }),
                    },
                  }),
                ]
              : []),
            ...(diskIds.scratch
              ? [
                  AttachedDiskSpec.create({
                    attachMode: AttachedDiskSpec_AttachMode.READ_WRITE,
                    deviceId: "scratch",
                    type: {
                      $case: "existingDisk",
                      existingDisk: ExistingDisk.create({
                        id: diskIds.scratch,
                      }),
                    },
                  }),
                ]
              : []),
          ],
          filesystems: [],
          cloudInitUserData: cloudInit,
          stopped: false,
          recoveryPolicy:
            spec.pricing_model === "spot"
              ? InstanceRecoveryPolicy.FAIL
              : InstanceRecoveryPolicy.RECOVER,
          preemptible:
            spec.pricing_model === "spot"
              ? PreemptibleSpec.create({
                  onPreemption: PreemptibleSpec_PreemptionPolicy.STOP,
                  priority: 3,
                })
              : undefined,
          hostname: name,
        }),
      }),
    );
    await createOp.wait();

    const runtime: HostRuntime = {
      provider: "nebius",
      instance_id: createOp.resourceId(),
      ssh_user: "ubuntu",
      zone: spec.region,
      metadata: {
        diskIds,
        diskTypeCode: dataDiskType.code,
        ...(scratchDiskType
          ? {
              scratchDiskTypeCode: scratchDiskType.code,
              shared_disk_id: diskIds.scratch,
              shared_disk_name:
                spec.metadata?.shared_disk_name ?? `${name}-scratch`,
            }
          : {}),
        subnetId,
      },
    };
    return runtime;
  }

  async startHost(runtime: HostRuntime, creds: NebiusProviderCreds) {
    const client = new NebiusClient(creds);
    const op = await client.instances.start(
      StartInstanceRequest.create({ id: runtime.instance_id }),
    );
    await op.wait();
  }

  async stopHost(runtime: HostRuntime, creds: NebiusProviderCreds) {
    const client = new NebiusClient(creds);
    try {
      const op = await client.instances.stop(
        StopInstanceRequest.create({ id: runtime.instance_id }),
      );
      await op.wait();
    } catch (err) {
      if (!isNotFoundError(err)) {
        throw err;
      }
      logger.info("nebius: stop ignored; instance missing", {
        instance_id: runtime.instance_id,
      });
    }
  }

  async restartHost(runtime: HostRuntime, creds: NebiusProviderCreds) {
    const client = new NebiusClient(creds);
    const stopOp = await client.instances.stop(
      StopInstanceRequest.create({ id: runtime.instance_id }),
    );
    await stopOp.wait();
    const startOp = await client.instances.start(
      StartInstanceRequest.create({ id: runtime.instance_id }),
    );
    await startOp.wait();
  }

  async deleteHost(
    runtime: HostRuntime,
    creds: NebiusProviderCreds,
    opts?: { preserveDataDisk?: boolean },
  ) {
    const client = new NebiusClient(creds);
    try {
      const op = await client.instances.delete(
        DeleteInstanceRequest.create({ id: runtime.instance_id }),
      );
      await op.wait();
    } catch (err) {
      if (!isNotFoundError(err)) {
        throw err;
      }
      logger.info("nebius: instance already deleted", {
        instance_id: runtime.instance_id,
      });
    }
    const diskIds = (runtime.metadata as NebiusRuntimeMeta | undefined)
      ?.diskIds;
    const disksToDelete = opts?.preserveDataDisk
      ? [diskIds?.boot]
      : [diskIds?.scratch, diskIds?.data, diskIds?.boot];
    for (const diskId of disksToDelete.filter(Boolean) as string[]) {
      await deleteDiskWithRetry(client, diskId, runtime.instance_id);
    }
  }

  async resizeDisk(
    runtime: HostRuntime,
    newSizeGb: number,
    creds: NebiusProviderCreds,
  ) {
    const client = new NebiusClient(creds);
    const diskIds = (runtime.metadata as NebiusRuntimeMeta | undefined)
      ?.diskIds;
    if (!diskIds?.data) {
      throw new Error("nebius: no data disk to resize");
    }
    const diskTypeCode = (runtime.metadata as NebiusRuntimeMeta | undefined)
      ?.diskTypeCode;
    await updateDiskSize({
      client,
      diskId: diskIds.data,
      diskType: diskTypeFromCode(diskTypeCode),
      sizeGib: newSizeGb,
    });
  }

  async resizeSharedScratchDisk(
    runtime: HostRuntime,
    newSizeGb: number,
    creds: NebiusProviderCreds,
  ) {
    const client = new NebiusClient(creds);
    const meta = runtime.metadata as NebiusRuntimeMeta | undefined;
    const diskId =
      meta?.diskIds?.scratch ?? (runtime.metadata as any)?.shared_disk_id;
    if (!diskId) {
      throw new Error("nebius: no shared scratch disk to resize");
    }
    const diskType = diskTypeFromCode(meta?.scratchDiskTypeCode);
    const normalized = normalizeDiskSizeGib(newSizeGb);
    await updateDiskSize({
      client,
      diskId,
      diskType,
      sizeGib: normalized.sizeGib,
      fallbackName: (runtime.metadata as any)?.shared_disk_name,
    });
  }

  async ensureSharedScratchDisk(
    runtime: HostRuntime,
    spec: HostSpec,
    creds: NebiusProviderCreds,
  ): Promise<HostRuntime> {
    const sharedDiskGb = Number(spec.shared_disk_gb ?? 0);
    if (!Number.isFinite(sharedDiskGb) || sharedDiskGb <= 0) {
      throw new Error("nebius: shared scratch disk size is required");
    }
    const parentId = creds.parentId;
    if (!parentId) {
      throw new Error("nebius parentId is required");
    }
    const client = new NebiusClient(creds);
    const meta = runtime.metadata as NebiusRuntimeMeta | undefined;
    const scratchDiskType = sharedScratchDiskTypeFor(spec);
    const normalized = normalizeDiskSizeGib(sharedDiskGb);
    const scratchDiskName =
      spec.metadata?.shared_disk_name ??
      (runtime.metadata as any)?.shared_disk_name ??
      `${spec.name}-scratch`;
    const existingScratchDiskId =
      meta?.diskIds?.scratch ??
      (runtime.metadata as any)?.shared_disk_id ??
      spec.metadata?.shared_disk_id ??
      spec.metadata?.sharedDiskId ??
      undefined;
    const scratchDiskId =
      existingScratchDiskId ??
      (await createDiskOrReuse(
        client,
        parentId,
        scratchDiskName,
        DiskSpec.create({
          type: scratchDiskType,
          blockSizeBytes: blockSizeBytes(),
          size: {
            $case: "sizeGibibytes",
            sizeGibibytes: Long.fromNumber(normalized.sizeGib),
          },
        }),
      ));
    const instance = await client.instances.get(
      GetInstanceRequest.create({ id: runtime.instance_id }),
    );
    const secondaryDisks = [...(instance.spec?.secondaryDisks ?? [])];
    const hasScratchAttachment = secondaryDisks.some((disk: any) => {
      const existingDisk =
        disk.type?.$case === "existingDisk"
          ? disk.type.existingDisk?.id
          : undefined;
      return disk.deviceId === "scratch" || existingDisk === scratchDiskId;
    });
    if (!hasScratchAttachment) {
      secondaryDisks.push(
        AttachedDiskSpec.create({
          attachMode: AttachedDiskSpec_AttachMode.READ_WRITE,
          deviceId: "scratch",
          type: {
            $case: "existingDisk",
            existingDisk: ExistingDisk.create({ id: scratchDiskId }),
          },
        }),
      );
      const op = await client.instances.update(
        UpdateInstanceRequest.create({
          metadata: ResourceMetadata.create({ id: runtime.instance_id }),
          spec: InstanceSpec.create({
            ...(instance.spec ?? {}),
            secondaryDisks,
          }),
        }),
      );
      await op.wait();
    }
    return {
      ...runtime,
      metadata: {
        ...(runtime.metadata ?? {}),
        diskIds: {
          ...(meta?.diskIds ?? {}),
          scratch: scratchDiskId,
        },
        scratchDiskTypeCode: scratchDiskType.code,
        shared_disk_id: scratchDiskId,
        shared_disk_name: scratchDiskName,
      },
    };
  }

  async deleteSharedScratchDisk(
    runtime: HostRuntime,
    creds: NebiusProviderCreds,
  ) {
    const client = new NebiusClient(creds);
    const diskId =
      (runtime.metadata as NebiusRuntimeMeta | undefined)?.diskIds?.scratch ??
      (runtime.metadata as any)?.shared_disk_id;
    if (!diskId) return;
    await deleteDiskWithRetry(client, diskId, runtime.instance_id);
  }

  async getInstance(
    runtime: HostRuntime,
    creds: NebiusProviderCreds,
  ): Promise<RemoteInstance | undefined> {
    const client = new NebiusClient(creds);
    let instance;
    try {
      instance = await client.instances.get(
        GetInstanceRequest.create({ id: runtime.instance_id }),
      );
    } catch (err) {
      if (isNotFoundError(err)) {
        logger.info("nebius: instance not found", {
          instance_id: runtime.instance_id,
        });
        return undefined;
      }
      throw err;
    }
    const status = instance.status?.state?.name;
    const publicIp = normalizeIp(
      instance.status?.networkInterfaces?.[0]?.publicIpAddress?.address,
    );
    const resources = instance.spec?.resources;
    const machineType =
      resources?.size?.$case === "preset" ? resources.size.preset : undefined;
    const platform = resources?.platform || undefined;
    const preemptibleSpec = instance.spec?.preemptible;
    const preemptible =
      preemptibleSpec?.onPreemption === PreemptibleSpec_PreemptionPolicy.STOP ||
      Number(preemptibleSpec?.priority ?? 0) > 0;
    return {
      instance_id: runtime.instance_id,
      name: instance.metadata?.name,
      status,
      public_ip: publicIp,
      metadata: {
        ...(machineType ? { machine_type: machineType } : {}),
        ...(platform ? { platform } : {}),
        pricing_model: preemptible ? "spot" : "on_demand",
        preemptible,
      },
    };
  }

  async getStatus(
    runtime: HostRuntime,
    creds: NebiusProviderCreds,
  ): Promise<"starting" | "running" | "stopped" | "error"> {
    const instance = await this.getInstance(runtime, creds);
    if (!instance) {
      return "stopped";
    }
    const state = instance?.status ?? "";
    if (state === InstanceStatus_InstanceState.RUNNING.name) return "running";
    if (state === InstanceStatus_InstanceState.STOPPED.name) return "stopped";
    if (state === InstanceStatus_InstanceState.STARTING.name) return "starting";
    return "error";
  }

  async listInstances(
    creds: NebiusProviderCreds,
    opts?: { namePrefix?: string },
  ): Promise<RemoteInstance[]> {
    const client = new NebiusClient(creds);
    const parentId = client.parentId();
    if (!parentId) return [];
    const res = await client.instances.list(
      ListInstancesRequest.create({
        parentId,
        pageSize: Long.fromNumber(999),
        pageToken: "",
      }),
    );
    const items = res.items ?? [];
    return items
      .filter((item) => {
        const name = item.metadata?.name ?? "";
        return opts?.namePrefix ? name.startsWith(opts.namePrefix) : true;
      })
      .map((item) => ({
        instance_id: item.metadata?.id ?? "",
        name: item.metadata?.name ?? "",
        status: item.status?.state?.toString(),
        public_ip: normalizeIp(
          item.status?.networkInterfaces?.[0]?.publicIpAddress?.address,
        ),
      }))
      .filter((item) => !!item.instance_id);
  }
}
