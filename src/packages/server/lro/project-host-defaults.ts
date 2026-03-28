import getPool from "@cocalc/database/pool";

const pool = () => getPool();

const UNKNOWN_HOST_DEFAULT_LIMIT = 1;
const MAX_CPU_BASED_PARALLEL_LIMIT = 32;

type ProjectHostLimitRow = {
  id: string;
  metadata: Record<string, any> | null;
  capacity: Record<string, any> | null;
};

function parsePositiveInt(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

function parseCpuCountFromString(value: unknown): number | undefined {
  const raw = `${value ?? ""}`.trim().toLowerCase();
  if (!raw) return undefined;
  const basename = raw.split("/").pop() ?? raw;
  const direct = parsePositiveInt(basename);
  if (direct != null) return direct;
  const vcpuMatch = basename.match(/(^|[^0-9])(\d+)\s*vcpus?(?:[^0-9]|$)/i);
  if (vcpuMatch) {
    return parsePositiveInt(vcpuMatch[2]);
  }
  const trailingMachineTypeDigits = basename.match(/-(\d+)$/);
  if (trailingMachineTypeDigits) {
    return parsePositiveInt(trailingMachineTypeDigits[1]);
  }
  return undefined;
}

function sizeLabelToCpuCount(size: unknown): number | undefined {
  switch (`${size ?? ""}`.trim().toLowerCase()) {
    case "small":
      return 2;
    case "medium":
      return 4;
    case "large":
      return 8;
    case "gpu":
      return 4;
    default:
      return parseCpuCountFromString(size);
  }
}

export function recommendedProjectHostParallelism(
  ncpus?: number | null,
): number {
  const cpu = parsePositiveInt(ncpus);
  if (cpu == null) return UNKNOWN_HOST_DEFAULT_LIMIT;
  return Math.min(
    MAX_CPU_BASED_PARALLEL_LIMIT,
    Math.max(UNKNOWN_HOST_DEFAULT_LIMIT, Math.floor(cpu / 2)),
  );
}

export function inferProjectHostCpuCount({
  metadata,
  capacity,
}: {
  metadata?: Record<string, any> | null;
  capacity?: Record<string, any> | null;
}): number | undefined {
  const machine = metadata?.machine ?? {};
  const machineMetadata = machine.metadata ?? {};
  const runtimeMetadata = metadata?.runtime?.metadata ?? {};
  return (
    parsePositiveInt(capacity?.cpu) ??
    parsePositiveInt(capacity?.cpus) ??
    parsePositiveInt(capacity?.vcpus) ??
    parsePositiveInt(machineMetadata.cpu) ??
    parsePositiveInt(machineMetadata.cpus) ??
    parsePositiveInt(machineMetadata.vcpus) ??
    parsePositiveInt(runtimeMetadata.cpu) ??
    parsePositiveInt(runtimeMetadata.cpus) ??
    parsePositiveInt(runtimeMetadata.vcpus) ??
    sizeLabelToCpuCount(metadata?.size) ??
    parseCpuCountFromString(machine.machine_type) ??
    parseCpuCountFromString(machineMetadata.machine_type) ??
    parseCpuCountFromString(runtimeMetadata.machine_type)
  );
}

export async function getProjectHostDefaultParallelLimit({
  host_id,
}: {
  host_id: string;
}): Promise<number> {
  const limits = await getProjectHostDefaultParallelLimits({
    host_ids: [host_id],
  });
  return limits.get(host_id) ?? UNKNOWN_HOST_DEFAULT_LIMIT;
}

export async function getProjectHostDefaultParallelLimits({
  host_ids,
}: {
  host_ids: string[];
}): Promise<Map<string, number>> {
  const normalizedIds = Array.from(
    new Set(host_ids.map((id) => `${id ?? ""}`.trim()).filter(Boolean)),
  );
  const result = new Map<string, number>(
    normalizedIds.map((id) => [id, UNKNOWN_HOST_DEFAULT_LIMIT] as const),
  );
  if (normalizedIds.length === 0) {
    return result;
  }
  const { rows } = await pool().query<ProjectHostLimitRow>(
    `
      SELECT id::text AS id, metadata, capacity
      FROM project_hosts
      WHERE id = ANY($1::uuid[])
    `,
    [normalizedIds],
  );
  for (const row of rows) {
    result.set(
      row.id,
      recommendedProjectHostParallelism(
        inferProjectHostCpuCount({
          metadata: row.metadata,
          capacity: row.capacity,
        }),
      ),
    );
  }
  return result;
}
