import { envToInt } from "@cocalc/backend/misc/env-to-number";
import getPool from "@cocalc/database/pool";

const pool = () => getPool();

export const BACKUP_TARGET_HOST_STALE_MS = Math.max(
  60_000,
  envToInt("COCALC_BACKUP_TARGET_HOST_STALE_MS", 4 * 60_000),
);

export type BackupTargetHostState = {
  project_id: string;
  host_id: string | null;
  host_status: string | null;
  host_last_seen: Date | null;
  host_deleted: Date | null;
};

export async function loadBackupTargetHostState(
  project_id: string,
): Promise<BackupTargetHostState | undefined> {
  const { rows } = await pool().query<BackupTargetHostState>(
    `
      SELECT
        p.project_id::text AS project_id,
        p.host_id::text AS host_id,
        h.status::text AS host_status,
        h.last_seen AS host_last_seen,
        h.deleted AS host_deleted
      FROM projects p
      LEFT JOIN project_hosts h ON h.id = p.host_id
      WHERE p.project_id = $1::uuid
      LIMIT 1
    `,
    [project_id],
  );
  return rows[0];
}

export function getBackupTargetUnavailabilityReason(
  state: BackupTargetHostState | undefined,
  {
    now = Date.now(),
    staleMs = BACKUP_TARGET_HOST_STALE_MS,
  }: {
    now?: number;
    staleMs?: number;
  } = {},
): string | undefined {
  if (!state) {
    return "project not found";
  }
  if (!state.host_id) {
    return "project has no assigned host";
  }
  if (state.host_deleted) {
    return `host ${state.host_id} is deleted`;
  }
  if (
    state.host_status &&
    !["running", "active"].includes(`${state.host_status}`.toLowerCase())
  ) {
    return `host ${state.host_id} status=${state.host_status}`;
  }
  if (!state.host_last_seen) {
    return `host ${state.host_id} has never heartbeated`;
  }
  const ageMs = now - state.host_last_seen.getTime();
  if (ageMs > staleMs) {
    return `host ${state.host_id} last_seen is stale (${ageMs}ms)`;
  }
  return undefined;
}

export async function assertBackupTargetHostAvailable({
  project_id,
  phase,
  load = loadBackupTargetHostState,
  now = Date.now(),
  staleMs = BACKUP_TARGET_HOST_STALE_MS,
}: {
  project_id: string;
  phase: string;
  load?: (project_id: string) => Promise<BackupTargetHostState | undefined>;
  now?: number;
  staleMs?: number;
}): Promise<BackupTargetHostState> {
  const state = await load(project_id);
  const reason = getBackupTargetUnavailabilityReason(state, { now, staleMs });
  if (reason) {
    throw new Error(`backup target unavailable during ${phase}: ${reason}`);
  }
  return state!;
}

export function watchBackupTargetHostAvailability({
  project_id,
  phase,
  pollMs,
  load = loadBackupTargetHostState,
  staleMs = BACKUP_TARGET_HOST_STALE_MS,
}: {
  project_id: string;
  phase: string;
  pollMs: number;
  load?: (project_id: string) => Promise<BackupTargetHostState | undefined>;
  staleMs?: number;
}): { promise: Promise<void>; stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveDone: () => void = () => {};
  let rejectDone: (err: Error) => void = () => {};

  const promise = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const schedule = () => {
    if (stopped) {
      resolveDone();
      return;
    }
    timer = setTimeout(() => {
      void check();
    }, pollMs);
    timer.unref?.();
  };

  const check = async () => {
    if (stopped) {
      resolveDone();
      return;
    }
    try {
      await assertBackupTargetHostAvailable({
        project_id,
        phase,
        load,
        staleMs,
      });
      schedule();
    } catch (err) {
      stopped = true;
      if (timer) clearTimeout(timer);
      rejectDone(err instanceof Error ? err : new Error(`${err}`));
    }
  };

  void check();

  return {
    promise,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      resolveDone();
    },
  };
}
