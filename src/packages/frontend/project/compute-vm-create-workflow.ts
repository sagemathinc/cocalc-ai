import type { ComputeApi, ComputeVolume } from "@cocalc/conat/hub/api/compute";
import type { VmCreateCliValues } from "./compute-vms-cli";
import { vmCreateCliProblem } from "./compute-vms-cli";
import {
  volumeCourseSource,
  volumeResizeFunding,
} from "./compute-volume-funding";
import { requireSponsoredHomeVolumes } from "@cocalc/util/compute-volume-funding";
import stableStringify from "json-stable-stringify";
import { uuid } from "@cocalc/util/misc";

export interface VmCreationAttempt {
  fingerprint: string;
  vmKey: string;
  volumeKey: string;
}

export async function prepareConnectedProjectSshKeys({
  projectIds,
  ensureProjectKey,
}: {
  projectIds: string[];
  ensureProjectKey: (projectId: string) => Promise<string>;
}): Promise<Map<string, string>> {
  const keys = new Map<string, string>();
  for (const projectId of Array.from(new Set(projectIds))) {
    const key = (await ensureProjectKey(projectId)).trim();
    if (!key) throw new Error(`Project ${projectId} has an empty SSH key.`);
    keys.set(projectId, key);
  }
  return keys;
}

export async function grantAdditionalVmProjectAccess({
  api,
  browser_id,
  vm_id,
  primary_project_id,
  projectKeys,
  idempotencyKey,
}: {
  api: Pick<ComputeApi, "grantVmProjectAccess">;
  browser_id?: string;
  vm_id: string;
  primary_project_id?: string;
  projectKeys: Map<string, string>;
  idempotencyKey: string;
}): Promise<void> {
  for (const [project_id, ssh_public_key] of projectKeys) {
    if (project_id === primary_project_id) continue;
    await api.grantVmProjectAccess({
      browser_id,
      id_or_name: vm_id,
      project_id,
      ssh_public_key,
      idempotency_key: `${idempotencyKey}:project:${project_id}`,
    });
  }
}

export async function prepareCourseFundedVmValues<T extends VmCreateCliValues>({
  values,
  project_id,
  projectSshPublicKey,
  generateProjectSshKey,
}: {
  values: T;
  project_id?: string;
  projectSshPublicKey: string | null;
  generateProjectSshKey: () => Promise<string>;
}): Promise<{ values: T; projectSshPublicKey: string | null }> {
  if (!values.funding_source) return { values, projectSshPublicKey };
  if (!project_id) {
    throw new Error("Course-funded VMs must be created from a CoCalc project.");
  }
  const publicKey =
    projectSshPublicKey ?? (await generateProjectSshKey()).trim();
  if (!publicKey) throw new Error("The project SSH public key is empty.");
  return {
    values: {
      ...values,
      allow_on_demand_fallback: false,
      configure_project_ssh: true,
      ssh_public_key: publicKey,
    },
    projectSshPublicKey: publicKey,
  };
}

/** Preserve both resource identities when an unchanged submission is retried
 * after a lost response or a failed fresh-auth attempt. */
export function vmCreationAttempt(
  previous: VmCreationAttempt | undefined,
  values: VmCreateCliValues,
  project_id?: string,
): VmCreationAttempt {
  const fingerprint = stableStringify({ project_id, values });
  if (fingerprint === undefined)
    throw Error("VM configuration could not be encoded.");
  return previous && previous.fingerprint === fingerprint
    ? previous
    : { fingerprint, vmKey: uuid(), volumeKey: uuid() };
}

export async function createVmWithHomeVolume({
  api,
  values,
  project_id,
  browser_id,
  vmKey,
  volumeKey,
  onVolumeCreated,
  wait = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}: {
  api: Pick<
    ComputeApi,
    "createVm" | "createVolume" | "getVolume" | "getCatalog"
  >;
  values: VmCreateCliValues;
  project_id?: string;
  browser_id?: string;
  vmKey: string;
  volumeKey: string;
  onVolumeCreated: (volume: ComputeVolume) => void;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}) {
  const problem = vmCreateCliProblem(values);
  if (problem) throw Error(problem);
  let home_volume = values.home_volume;
  let expected_home_volume_funding_version =
    values.expected_home_volume_funding_version;
  if (values.home_volume && !values.create_home_volume) {
    const volume = await api.getVolume({ id_or_name: values.home_volume });
    if (volumeCourseSource(volume)) {
      requireSponsoredHomeVolumes(await api.getCatalog({}));
      const currentVersion =
        volumeResizeFunding(volume).expected_funding_version;
      if (currentVersion !== expected_home_volume_funding_version)
        throw Error(
          "Home volume funding changed. Review its payer and retention again.",
        );
    }
  }
  if (
    values.funding_source &&
    (values.create_home_volume || values.home_volume)
  )
    requireSponsoredHomeVolumes(await api.getCatalog({}));
  if (values.create_home_volume) {
    if (!values.new_home_volume_name || !values.new_home_volume_size_gb)
      throw Error("A new home volume name and size are required.");
    let volume = await api.createVolume({
      project_id,
      browser_id,
      name: values.new_home_volume_name,
      provider: values.provider,
      region: values.region,
      zone: values.zone,
      size_gb: values.new_home_volume_size_gb,
      funding_mode: values.funding_mode,
      funding_source: values.funding_source,
      accept_course_retention: values.accept_course_retention,
      idempotency_key: volumeKey,
    });
    onVolumeCreated(volume);
    const deadline = now() + 5 * 60_000;
    while (volume.state !== "ready") {
      if (
        ["failed", "deleted"].includes(volume.state) ||
        volume.desired_state === "deleted"
      )
        throw Error(volume.error || "Home volume creation failed.");
      if (now() >= deadline)
        throw Error(
          "Home volume is still provisioning. Select the retained volume after it becomes ready.",
        );
      await wait(2000);
      volume = await api.getVolume({ id_or_name: volume.id });
    }
    const source = volumeCourseSource(volume);
    if (
      values.funding_source &&
      (!source ||
        source.kind !== "course" ||
        source.pool_id !== values.funding_source.pool_id ||
        source.grant_id !== values.funding_source.grant_id ||
        (source.payer_account_id != null &&
          source.payer_account_id !== values.funding_source.payer_account_id))
    ) {
      throw Error(
        "Home volume funding does not match the selected course. VM creation was not requested.",
      );
    }
    expected_home_volume_funding_version =
      volumeResizeFunding(volume).expected_funding_version;
    home_volume = volume.name;
  }
  return await api.createVm({
    project_id,
    browser_id,
    name: values.name,
    provider: values.provider,
    operating_system: values.operating_system,
    funding_mode: values.funding_mode,
    funding_source: values.funding_source,
    architecture: values.architecture,
    region: values.region,
    zone: values.zone,
    machine_type: values.machine_type,
    provider_spec: values.provider_platform
      ? { platform: values.provider_platform }
      : undefined,
    gpu_type:
      values.gpu_type && values.gpu_type !== "none"
        ? values.gpu_type
        : undefined,
    gpu_count: values.gpu_count,
    pricing_model: values.pricing_model,
    allow_on_demand_fallback: values.allow_on_demand_fallback,
    ttl_minutes: values.ttl_minutes ?? null,
    stop_after_minutes:
      values.stop_after_minutes === undefined ? 360 : values.stop_after_minutes,
    boot_disk_gb: values.boot_disk_gb,
    home_volume,
    expected_home_volume_funding_version,
    ssh_public_key: values.ssh_public_key,
    configure_project_ssh: values.configure_project_ssh,
    idempotency_key: vmKey,
  });
}
