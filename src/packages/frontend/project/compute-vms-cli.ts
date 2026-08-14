/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export interface VmCreateCliValues {
  name: string;
  provider: "gcp" | "nebius";
  operating_system: "linux" | "windows";
  funding_mode: "site-funded" | "account-postpaid" | "account-prepaid";
  architecture: "x86_64" | "arm64";
  region: string;
  zone?: string;
  machine_type: string;
  gpu_type?: string;
  gpu_count?: number;
  pricing_model: "spot" | "on_demand";
  allow_on_demand_fallback: boolean;
  ttl_minutes?: number | null;
  boot_disk_gb: number;
  home_volume?: string;
  create_home_volume?: boolean;
  new_home_volume_name?: string;
  new_home_volume_size_gb?: number;
  ssh_public_key?: string;
  configure_project_ssh?: boolean;
}

export interface VolumeCreateCliValues {
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
  project_id: string;
  values: Partial<VmCreateCliValues>;
}): string {
  const { values } = opts;
  const volumeName = values.create_home_volume
    ? values.new_home_volume_name
    : values.home_volume;
  const args = [
    "cocalc",
    "vm",
    "create",
    "--project",
    opts.project_id,
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
  if (values.zone) args.push("--zone", values.zone);
  if (values.gpu_type && values.gpu_type !== "none") {
    args.push("--gpu-type", values.gpu_type);
  }
  if (values.gpu_count) args.push("--gpu-count", `${values.gpu_count}`);
  if (values.ttl_minutes != null) {
    args.push(`--ttl=${ttlArgument(values.ttl_minutes)}`);
  }
  args.push(`--boot-disk-gb=${values.boot_disk_gb ?? 20}`);
  if (values.pricing_model === "spot") args.push("--spot");
  if (values.allow_on_demand_fallback) {
    args.push("--allow-standard-fallback");
  }
  if (volumeName) args.push("--home-volume", shellQuote(volumeName));
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
      region: values.region,
      zone: values.zone,
      size_gb: values.new_home_volume_size_gb,
    },
  });
  return createVolume + " && " + createVm;
}

export function volumeCreateCli(opts: {
  api: string;
  project_id: string;
  values: Partial<VolumeCreateCliValues>;
}): string {
  const args = [
    "cocalc",
    "vm",
    "volume",
    "create",
    "--project",
    opts.project_id,
    "--provider",
    opts.values.provider ?? "gcp",
    "--funding-mode",
    opts.values.funding_mode ?? "account-prepaid",
    "--region",
    opts.values.region ?? "us-central1",
    `--size-gb=${opts.values.size_gb ?? 50}`,
  ];
  if (opts.values.zone) args.push("--zone", opts.values.zone);
  args.push("--wait", shellQuote(opts.values.name || "home-volume-name"));
  return args.join(" ");
}
