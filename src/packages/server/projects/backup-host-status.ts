import { conat } from "@cocalc/backend/conat";
import getPool from "@cocalc/database/pool";
import {
  createHostControlClient,
  type HostBackupExecutionStatus,
} from "@cocalc/conat/project-host/api";

const pool = () => getPool();
const ACTIVE_HOST_LOOKBACK_MS = 10 * 60_000;
const HOST_STATUS_TIMEOUT_MS = 5_000;

type ActiveProjectHostRow = {
  id: string;
};

export type HostLocalBackupStatusRow = HostBackupExecutionStatus & {
  host_id: string;
};

export async function listActiveProjectHosts(): Promise<
  ActiveProjectHostRow[]
> {
  const { rows } = await pool().query<ActiveProjectHostRow>(
    `
      SELECT id
      FROM project_hosts
      WHERE deleted IS NULL
        AND status = 'running'
        AND last_seen IS NOT NULL
        AND last_seen > now() - ($1::text || ' milliseconds')::interval
      ORDER BY id
    `,
    [ACTIVE_HOST_LOOKBACK_MS],
  );
  return rows;
}

export async function listHostLocalBackupStatuses(): Promise<{
  rows: HostLocalBackupStatusRow[];
  unreachable_hosts: number;
}> {
  const hosts = await listActiveProjectHosts();
  if (hosts.length === 0) {
    return { rows: [], unreachable_hosts: 0 };
  }
  let client;
  try {
    client = await conat();
  } catch {
    return { rows: [], unreachable_hosts: hosts.length };
  }
  const results = await Promise.allSettled(
    hosts.map(async ({ id }) => ({
      host_id: id,
      ...(await createHostControlClient({
        host_id: id,
        client,
        timeout: HOST_STATUS_TIMEOUT_MS,
      }).getBackupExecutionStatus()),
    })),
  );
  const rows: HostLocalBackupStatusRow[] = [];
  let unreachable_hosts = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      rows.push(result.value);
    } else {
      unreachable_hosts += 1;
    }
  }
  return { rows, unreachable_hosts };
}
