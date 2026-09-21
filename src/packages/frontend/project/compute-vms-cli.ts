/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CourseVmFundingSource } from "@cocalc/util/compute-vm-funding";

export interface VmCreateCliValues {
  name: string;
  provider: "gcp" | "nebius";
  operating_system: "linux" | "windows";
  funding_mode: "site-funded" | "account-postpaid" | "account-prepaid";
  funding_source?: CourseVmFundingSource;
  architecture: "x86_64" | "arm64";
  region: string;
  zone?: string;
  machine_type: string;
  provider_platform?: string;
  gpu_type?: string;
  gpu_count?: number;
  pricing_model: "spot" | "on_demand";
  allow_on_demand_fallback: boolean;
  ttl_minutes?: number | null;
  stop_after_minutes?: number | null;
  boot_disk_gb: number;
  home_volume?: string;
  expected_home_volume_funding_version?: string;
  accept_course_retention?: boolean;
  create_home_volume?: boolean;
  new_home_volume_name?: string;
  new_home_volume_size_gb?: number;
  ssh_public_key?: string;
  configure_project_ssh?: boolean;
}

export interface VolumeCreateCliValues {
  funding_source?: CourseVmFundingSource;
  accept_course_retention?: boolean;
  name: string;
  provider: "gcp" | "nebius";
  funding_mode: "site-funded" | "account-postpaid" | "account-prepaid";
  region: string;
  zone?: string;
  size_gb: number;
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.split("'").join(`'\\''`)}'`;
}

function ttlArgument(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function vmCreateCli(opts: {
  api: string;
  project_id?: string;
  values: Partial<VmCreateCliValues>;
}): string {
  const { values } = opts;
  const problem = vmCreateCliProblem(values);
  if (problem) throw new Error(problem);
  const volumeName = values.create_home_volume
    ? values.new_home_volume_name
    : values.home_volume;
  const args = [
    "cocalc",
    "vm",
    "create",
    "--provider",
    values.provider ?? "gcp",
    "--os",
    values.operating_system ?? "linux",
    "--funding-mode",
    values.funding_mode ?? "account-prepaid",
    "--architecture",
    values.architecture ?? "x86_64",
    "--region",
    values.region ?? "us-central1",
    "--machine",
    values.machine_type ?? "e2-standard-2",
  ];
  if (opts.project_id) args.splice(3, 0, "--project", opts.project_id);
  if (values.funding_source) {
    args.push(
      "--funding-payer",
      shellQuote(values.funding_source.payer_account_id!),
      "--funding-pool",
      shellQuote(values.funding_source.pool_id),
      "--funding-grant",
      shellQuote(values.funding_source.grant_id),
    );
  }
  if (values.zone) args.push("--zone", values.zone);
  if (values.provider_platform) {
    args.push("--provider-platform", values.provider_platform);
  }
  if (values.gpu_type && values.gpu_type !== "none") {
    args.push("--gpu-type", values.gpu_type);
  }
  if (values.gpu_count) args.push("--gpu-count", `${values.gpu_count}`);
  if (values.ttl_minutes != null) {
    args.push(`--ttl=${ttlArgument(values.ttl_minutes)}`);
  }
  args.push(
    values.stop_after_minutes === null
      ? "--no-scheduled-stop"
      : `--stop-after=${ttlArgument(values.stop_after_minutes ?? 360)}`,
  );
  args.push(`--boot-disk-gb=${values.boot_disk_gb ?? 20}`);
  if (values.pricing_model === "spot") args.push("--spot");
  if (values.allow_on_demand_fallback) {
    args.push("--allow-standard-fallback");
  }
  if (volumeName) args.push("--home-volume", shellQuote(volumeName));
  if (values.expected_home_volume_funding_version && !values.create_home_volume)
    args.push(
      "--home-volume-funding-version",
      shellQuote(values.expected_home_volume_funding_version),
    );
  if (values.configure_project_ssh === false) {
    args.push("--no-configure-project-ssh");
  }
  if (values.ssh_public_key?.trim()) {
    args.push(
      "--ssh-public-key-value",
      shellQuote(values.ssh_public_key.trim()),
    );
  } else {
    args.push("--no-ssh-key");
  }
  args.push("--wait", shellQuote(values.name || "vm-name"));
  const createVm = args.join(" ");
  if (!values.create_home_volume) return createVm;
  const createVolume = volumeCreateCli({
    api: opts.api,
    project_id: opts.project_id,
    values: {
      name: values.new_home_volume_name,
      provider: values.provider,
      funding_mode: values.funding_mode,
      funding_source: values.funding_source,
      accept_course_retention: values.accept_course_retention,
      region: values.region,
      zone: values.zone,
      size_gb: values.new_home_volume_size_gb,
    },
  });
  // The volume's version only exists after creation. Resolve it explicitly in
  // the shell before attaching; the backend checks it again under its lock.
  if (values.funding_source) {
    const name = shellQuote(volumeName || "home-volume-name");
    const readVersion = `cocalc vm volume funding ${name} --version-only`;
    return (
      createVolume +
      ` && home_volume_funding_version="$(${readVersion})" && ` +
      createVm +
      ' --home-volume-funding-version "$home_volume_funding_version"'
    );
  }
  return createVolume + " && " + createVm;
}

export function vmCreateCliProblem(
  values: Partial<VmCreateCliValues>,
): string | undefined {
  if (!values.funding_source) return;
  if (values.create_home_volume && !values.accept_course_retention)
    return "Accept the home volume's independent course retention policy before creation.";
  if (
    !values.funding_source.payer_account_id ||
    !values.funding_source.pool_id ||
    !values.funding_source.grant_id
  )
    return "The course funding payer, pool, and grant are required.";
}

export function volumeCreateCli(opts: {
  api: string;
  project_id?: string;
  values: Partial<VolumeCreateCliValues>;
}): string {
  const problem = volumeCreateCliProblem(opts.values);
  if (problem) throw new Error(problem);
  const args = [
    "cocalc",
    "vm",
    "volume",
    "create",
    "--provider",
    opts.values.provider ?? "gcp",
    "--funding-mode",
    opts.values.funding_mode ?? "account-prepaid",
    "--region",
    opts.values.region ?? "us-central1",
    `--size-gb=${opts.values.size_gb ?? 50}`,
  ];
  if (opts.project_id) args.splice(4, 0, "--project", opts.project_id);
  const source = opts.values.funding_source;
  if (source)
    args.push(
      "--funding-payer",
      shellQuote(source.payer_account_id!),
      "--funding-pool",
      shellQuote(source.pool_id),
      "--funding-grant",
      shellQuote(source.grant_id),
      "--accept-course-retention",
    );
  if (opts.values.zone) args.push("--zone", opts.values.zone);
  args.push("--wait", shellQuote(opts.values.name || "home-volume-name"));
  return args.join(" ");
}

export function volumeCreateCliProblem(
  values: Partial<VolumeCreateCliValues>,
): string | undefined {
  return vmCreateCliProblem({ ...values, create_home_volume: true });
}
