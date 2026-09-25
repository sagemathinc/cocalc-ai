// Recommendations are presentation metadata, never spending authorization.
export interface CourseVmTemplateConfig {
  provider: "gcp" | "nebius";
  operating_system: "linux" | "windows";
  architecture: "x86_64" | "arm64";
  region: string;
  zone?: string;
  machine_type: string;
  provider_platform?: string;
  gpu_type?: string;
  gpu_count: number;
  pricing_model: "spot" | "on_demand";
  boot_disk_gb: number;
}

export interface CourseVmTemplate {
  id: string;
  label: string;
  description?: string;
  config: CourseVmTemplateConfig;
}

export interface CourseVmRecommendations {
  templates: CourseVmTemplate[];
  version: number;
}

export const MAX_COURSE_VM_TEMPLATES = 10;
const CONFIG_KEYS = [
  "provider",
  "operating_system",
  "architecture",
  "region",
  "zone",
  "machine_type",
  "provider_platform",
  "gpu_type",
  "gpu_count",
  "pricing_model",
  "boot_disk_gb",
];

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid VM recommendation");
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error(
      "VM recommendations may contain only labels and hardware configuration",
    );
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 128): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new Error(`Invalid recommendation ${label}`);
  return value.trim();
}
function choice<T extends string>(
  value: unknown,
  options: readonly T[],
  label: string,
): T {
  if (!options.includes(value as T))
    throw new Error(`Invalid recommendation ${label}`);
  return value as T;
}

export function normalizeCourseVmTemplates(value: unknown): CourseVmTemplate[] {
  if (!Array.isArray(value) || value.length > MAX_COURSE_VM_TEMPLATES)
    throw new Error(
      `At most ${MAX_COURSE_VM_TEMPLATES} VM recommendations are allowed`,
    );
  const ids = new Set<string>();
  return value.map((entry) => {
    const row = object(entry, ["id", "label", "description", "config"]);
    const id = text(row.id, "id", 80);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id))
      throw new Error("Recommendation IDs must be unique");
    ids.add(id);
    const raw = object(row.config, CONFIG_KEYS);
    const config: CourseVmTemplateConfig = {
      provider: choice(raw.provider, ["gcp", "nebius"], "provider"),
      operating_system: choice(
        raw.operating_system,
        ["linux", "windows"],
        "operating system",
      ),
      architecture: choice(
        raw.architecture,
        ["x86_64", "arm64"],
        "architecture",
      ),
      region: text(raw.region, "region"),
      machine_type: text(raw.machine_type, "machine"),
      gpu_count: raw.gpu_count as number,
      pricing_model: choice(
        raw.pricing_model,
        ["spot", "on_demand"],
        "pricing model",
      ),
      boot_disk_gb: raw.boot_disk_gb as number,
    };
    for (const key of ["zone", "provider_platform", "gpu_type"] as const)
      if (raw[key] !== undefined) config[key] = text(raw[key], key);
    if (
      !Number.isSafeInteger(config.gpu_count) ||
      config.gpu_count < 0 ||
      config.gpu_count > 256
    )
      throw new Error("Invalid recommendation GPU count");
    if (
      !Number.isSafeInteger(config.boot_disk_gb) ||
      config.boot_disk_gb < 10 ||
      config.boot_disk_gb > 65536
    )
      throw new Error("Invalid recommendation boot disk size");
    return {
      id,
      label: text(row.label, "label", 80),
      ...(row.description === undefined || row.description === ""
        ? {}
        : { description: text(row.description, "description", 500) }),
      config,
    };
  });
}
