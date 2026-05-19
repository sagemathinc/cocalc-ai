import { randomUUID } from "crypto";
import getPool from "@cocalc/database/pool";

const pool = () => getPool();

const DEFAULT_STALE_IN_PROGRESS_MS = 30 * 60 * 1000;
const FAST_LIFECYCLE_STALE_IN_PROGRESS_MS = 3 * 60 * 1000;
const NORMAL_LIFECYCLE_STALE_IN_PROGRESS_MS = 5 * 60 * 1000;
const SPOT_PROBE_STALE_IN_PROGRESS_MS = 12 * 60 * 1000;

export const CLOUD_VM_WORK_STALE_IN_PROGRESS_MS_BY_ACTION: Record<
  string,
  number
> = {
  start: FAST_LIFECYCLE_STALE_IN_PROGRESS_MS,
  verify_host_ready: FAST_LIFECYCLE_STALE_IN_PROGRESS_MS,
  refresh_runtime: FAST_LIFECYCLE_STALE_IN_PROGRESS_MS,
  stop: NORMAL_LIFECYCLE_STALE_IN_PROGRESS_MS,
  restart: NORMAL_LIFECYCLE_STALE_IN_PROGRESS_MS,
  hard_restart: NORMAL_LIFECYCLE_STALE_IN_PROGRESS_MS,
  probe_spot: SPOT_PROBE_STALE_IN_PROGRESS_MS,
  provision: DEFAULT_STALE_IN_PROGRESS_MS,
  delete: DEFAULT_STALE_IN_PROGRESS_MS,
  bootstrap: DEFAULT_STALE_IN_PROGRESS_MS,
};

export type CloudVmLogEvent = {
  vm_id: string;
  action: string;
  status: string;
  provider?: string;
  spec?: Record<string, any>;
  runtime?: Record<string, any>;
  pricing_version?: string;
  error?: string;
};

export type CloudVmLogEntry = CloudVmLogEvent & {
  id: string;
  ts: Date | null;
};

export type CloudVmWorkRow = {
  id: string;
  vm_id: string;
  action: string;
  payload: Record<string, any>;
  state: string;
  not_before?: Date;
  attempt: number;
  locked_by?: string;
  locked_at?: Date;
  error?: string;
  created_at?: Date;
  updated_at?: Date;
};

function normalizeNotBefore(value?: Date | string): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid not_before '${value}'`);
  }
  return parsed;
}

export function getCloudVmWorkStaleInProgressMs(action?: string): number {
  const raw = process.env.COCALC_CLOUD_VM_WORK_STALE_IN_PROGRESS_MS;
  if (!raw) {
    return (
      CLOUD_VM_WORK_STALE_IN_PROGRESS_MS_BY_ACTION[action ?? ""] ??
      DEFAULT_STALE_IN_PROGRESS_MS
    );
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return (
      CLOUD_VM_WORK_STALE_IN_PROGRESS_MS_BY_ACTION[action ?? ""] ??
      DEFAULT_STALE_IN_PROGRESS_MS
    );
  }
  return value;
}

function buildActionStaleMsCase(params: any[]): string {
  const cases = Object.entries(CLOUD_VM_WORK_STALE_IN_PROGRESS_MS_BY_ACTION)
    .map(([action, ms]) => {
      params.push(action, ms);
      return `WHEN $${params.length - 1} THEN $${params.length}::double precision`;
    })
    .join("\n");
  params.push(DEFAULT_STALE_IN_PROGRESS_MS);
  return `(CASE action
            ${cases}
            ELSE $${params.length}::double precision
          END)`;
}

export async function logCloudVmEvent(event: CloudVmLogEvent): Promise<void> {
  const id = randomUUID();
  await pool().query(
    `
      INSERT INTO cloud_vm_log
        (id, vm_id, ts, action, status, provider, spec, runtime, pricing_version, error)
      VALUES ($1,$2,NOW(),$3,$4,$5,$6,$7,$8,$9)
    `,
    [
      id,
      event.vm_id,
      event.action,
      event.status,
      event.provider ?? null,
      event.spec ?? null,
      event.runtime ?? null,
      event.pricing_version ?? null,
      event.error ?? null,
    ],
  );

  await pool().query(
    `
      UPDATE project_hosts
      SET metadata = jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{last_action}', to_jsonb($2::text)
            ),
            '{last_action_at}', to_jsonb(NOW())
          ),
          '{last_action_status}', to_jsonb($3::text)
        ),
        '{last_action_error}', COALESCE(to_jsonb($4::text), 'null'::jsonb)
      )
      WHERE id=$1 AND deleted IS NULL
    `,
    [event.vm_id, event.action, event.status, event.error ?? null],
  );
}

export async function listCloudVmLog(opts: {
  vm_id: string;
  limit?: number;
}): Promise<CloudVmLogEntry[]> {
  const { rows } = await pool().query<CloudVmLogEntry>(
    `
      SELECT id, vm_id, ts, action, status, provider, spec, runtime, pricing_version, error
      FROM cloud_vm_log
      WHERE vm_id=$1
      ORDER BY ts DESC NULLS LAST
      LIMIT $2
    `,
    [opts.vm_id, opts.limit ?? 50],
  );
  return rows;
}

export async function enqueueCloudVmWork(row: {
  vm_id: string;
  action: string;
  payload?: Record<string, any>;
  not_before?: Date | string;
}): Promise<string> {
  const id = randomUUID();
  const notBefore = normalizeNotBefore(row.not_before);
  await pool().query(
    `
      INSERT INTO cloud_vm_work
        (id, vm_id, action, payload, state, not_before, created_at, updated_at)
      VALUES ($1,$2,$3,$4,'queued',$5,NOW(),NOW())
    `,
    [id, row.vm_id, row.action, row.payload ?? {}, notBefore],
  );
  return id;
}

export async function enqueueCloudVmWorkOnce(row: {
  vm_id: string;
  action: string;
  payload?: Record<string, any>;
  not_before?: Date | string;
}): Promise<string | undefined> {
  const id = randomUUID();
  const notBefore = normalizeNotBefore(row.not_before);
  const { rowCount } = await pool().query(
    `
      INSERT INTO cloud_vm_work
        (id, vm_id, action, payload, state, not_before, created_at, updated_at)
      SELECT $1,$2,$3,$4,'queued',$5,NOW(),NOW()
      WHERE NOT EXISTS (
        SELECT 1
        FROM cloud_vm_work
        WHERE vm_id=$2
          AND action=$3
          AND state IN ('queued','in_progress')
      )
    `,
    [id, row.vm_id, row.action, row.payload ?? {}, notBefore],
  );
  if (!rowCount && notBefore) {
    await pool().query(
      `
        UPDATE cloud_vm_work
        SET not_before = LEAST(COALESCE(not_before, $3), $3),
            updated_at = NOW()
        WHERE vm_id=$1
          AND action=$2
          AND state='queued'
      `,
      [row.vm_id, row.action, notBefore],
    );
  }
  return rowCount ? id : undefined;
}

export async function requeueStaleCloudVmWork(
  opts: {
    older_than_ms?: number;
    limit?: number;
  } = {},
): Promise<number> {
  const limit = opts.limit ?? 100;
  if (limit <= 0) return 0;
  const olderThanMs = opts.older_than_ms;
  if (olderThanMs !== undefined && olderThanMs <= 0) return 0;
  const envOverride = process.env.COCALC_CLOUD_VM_WORK_STALE_IN_PROGRESS_MS;
  const uniformOlderThanMs =
    olderThanMs ??
    (envOverride ? getCloudVmWorkStaleInProgressMs() : undefined);

  const params: any[] = [];
  let stalePredicate: string;
  if (uniformOlderThanMs !== undefined) {
    params.push(new Date(Date.now() - uniformOlderThanMs));
    stalePredicate = `locked_at < $${params.length}`;
  } else {
    const actionMsCase = buildActionStaleMsCase(params);
    stalePredicate = `locked_at < NOW() - (${actionMsCase} * interval '1 millisecond')`;
  }
  params.push(limit);
  const limitIndex = params.length;
  const { rowCount } = await pool().query(
    `
      WITH stale AS (
        SELECT id
        FROM cloud_vm_work
        WHERE state='in_progress'
          AND locked_at IS NOT NULL
          AND ${stalePredicate}
        ORDER BY locked_at ASC
        LIMIT $${limitIndex}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE cloud_vm_work AS work
      SET state='queued',
          locked_by=NULL,
          locked_at=NULL,
          attempt=COALESCE(work.attempt, 0) + 1,
          error='requeued stale in-progress cloud work',
          updated_at=NOW()
      FROM stale
      WHERE work.id=stale.id
    `,
    params,
  );
  return rowCount ?? 0;
}

export async function claimCloudVmWork(opts: {
  limit?: number;
  worker_id: string;
}): Promise<CloudVmWorkRow[]> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<CloudVmWorkRow>(
      `
        SELECT *
        FROM cloud_vm_work
        WHERE state='queued'
          AND (not_before IS NULL OR not_before <= NOW())
        ORDER BY COALESCE(not_before, created_at), created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `,
      [opts.limit ?? 1],
    );
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      await client.query(
        `
          UPDATE cloud_vm_work
          SET state='in_progress',
              locked_by=$1,
              locked_at=now(),
              updated_at=now()
          WHERE id = ANY($2)
        `,
        [opts.worker_id, ids],
      );
    }
    await client.query("COMMIT");
    return rows;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function refreshCloudVmWorkLease(opts: {
  id: string;
  worker_id: string;
}): Promise<boolean> {
  const { rowCount } = await pool().query(
    `
      UPDATE cloud_vm_work
      SET locked_at=NOW(),
          updated_at=NOW()
      WHERE id=$1
        AND state='in_progress'
        AND locked_by=$2
    `,
    [opts.id, opts.worker_id],
  );
  return !!rowCount;
}

export async function markCloudVmWorkDone(
  id: string,
  updates: { error?: string } = {},
): Promise<void> {
  await pool().query(
    `
      UPDATE cloud_vm_work
      SET state='done',
          error=$2,
          locked_by=NULL,
          locked_at=NULL,
          updated_at=now()
      WHERE id=$1
    `,
    [id, updates.error ?? null],
  );
}

export async function markCloudVmWorkFailed(
  id: string,
  error: string,
): Promise<void> {
  await pool().query(
    `
      UPDATE cloud_vm_work
      SET state='failed',
          error=$2,
          locked_by=NULL,
          locked_at=NULL,
          updated_at=now()
      WHERE id=$1
    `,
    [id, error],
  );
}

// No legacy metadata normalization: new installs should only use canonical
// provider ids (e.g., "gcp", "hyperstack", "lambda").
