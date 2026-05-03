/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getDatabase, initDatabase } from "@cocalc/lite/hub/sqlite/database";

export interface ProjectPortLeaseRow {
  project_id: string;
  ssh_port: number;
  http_port: number;
  updated_at?: number;
}

export const SSH_PORT_LEASE_START = 30_000;
export const HTTP_PORT_LEASE_START = 45_000;
export const PROJECT_PORT_LEASE_CAPACITY = 15_000;

function ensureProjectPortLeasesTable(): void {
  const db = initDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_port_leases (
      project_id TEXT PRIMARY KEY,
      ssh_port INTEGER NOT NULL UNIQUE,
      http_port INTEGER NOT NULL UNIQUE,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS project_port_leases_ssh_idx ON project_port_leases(ssh_port)",
  );
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS project_port_leases_http_idx ON project_port_leases(http_port)",
  );
}

function offsetFromSshPort(port?: number | null): number | undefined {
  if (!Number.isInteger(port)) return;
  const offset = Number(port) - SSH_PORT_LEASE_START;
  if (offset < 0 || offset >= PROJECT_PORT_LEASE_CAPACITY) return;
  return offset;
}

function offsetFromHttpPort(port?: number | null): number | undefined {
  if (!Number.isInteger(port)) return;
  const offset = Number(port) - HTTP_PORT_LEASE_START;
  if (offset < 0 || offset >= PROJECT_PORT_LEASE_CAPACITY) return;
  return offset;
}

function currentRunningProjectPorts(project_id: string): {
  sshOffsets: Set<number>;
  httpOffsets: Set<number>;
} {
  const sshOffsets = new Set<number>();
  const httpOffsets = new Set<number>();
  const db = getDatabase();
  try {
    const rows = db
      .prepare(
        `
          SELECT project_id, ssh_port, http_port
          FROM projects
          WHERE project_id != ?
            AND state IN ('running', 'starting')
        `,
      )
      .all(project_id) as Array<{
      project_id: string;
      ssh_port?: number | null;
      http_port?: number | null;
    }>;
    for (const row of rows) {
      const sshOffset = offsetFromSshPort(row.ssh_port);
      if (sshOffset != null) sshOffsets.add(sshOffset);
      const httpOffset = offsetFromHttpPort(row.http_port);
      if (httpOffset != null) httpOffsets.add(httpOffset);
    }
  } catch {
    // The projects table may not exist yet during early startup/tests.
  }
  return { sshOffsets, httpOffsets };
}

export function getProjectPortLease(
  project_id: string,
): ProjectPortLeaseRow | undefined {
  ensureProjectPortLeasesTable();
  const db = getDatabase();
  return db
    .prepare(
      `
        SELECT project_id, ssh_port, http_port, updated_at
        FROM project_port_leases
        WHERE project_id=?
      `,
    )
    .get(project_id) as ProjectPortLeaseRow | undefined;
}

export function acquireProjectPortLease(
  project_id: string,
  opts?: { rotate?: boolean },
): ProjectPortLeaseRow {
  ensureProjectPortLeasesTable();
  const db = getDatabase();
  const previous = getProjectPortLease(project_id);
  if (!opts?.rotate) {
    if (previous) return previous;
  } else {
    db.prepare("DELETE FROM project_port_leases WHERE project_id=?").run(
      project_id,
    );
  }

  const rows = db
    .prepare(
      `
        SELECT project_id, ssh_port, http_port
        FROM project_port_leases
        WHERE project_id != ?
      `,
    )
    .all(project_id) as Array<{
    project_id: string;
    ssh_port: number;
    http_port: number;
  }>;
  const usedOffsets = new Set<number>();
  if (opts?.rotate) {
    const previousSshOffset = offsetFromSshPort(previous?.ssh_port);
    if (previousSshOffset != null) usedOffsets.add(previousSshOffset);
    const previousHttpOffset = offsetFromHttpPort(previous?.http_port);
    if (previousHttpOffset != null) usedOffsets.add(previousHttpOffset);
  }
  for (const row of rows) {
    const sshOffset = offsetFromSshPort(row.ssh_port);
    if (sshOffset != null) usedOffsets.add(sshOffset);
    const httpOffset = offsetFromHttpPort(row.http_port);
    if (httpOffset != null) usedOffsets.add(httpOffset);
  }
  const runningPorts = currentRunningProjectPorts(project_id);
  for (const offset of runningPorts.sshOffsets) usedOffsets.add(offset);
  for (const offset of runningPorts.httpOffsets) usedOffsets.add(offset);

  for (let offset = 0; offset < PROJECT_PORT_LEASE_CAPACITY; offset += 1) {
    if (usedOffsets.has(offset)) continue;
    const row: ProjectPortLeaseRow = {
      project_id,
      ssh_port: SSH_PORT_LEASE_START + offset,
      http_port: HTTP_PORT_LEASE_START + offset,
      updated_at: Date.now(),
    };
    db.prepare(
      `
        INSERT INTO project_port_leases(project_id, ssh_port, http_port, updated_at)
        VALUES (?, ?, ?, ?)
      `,
    ).run(row.project_id, row.ssh_port, row.http_port, row.updated_at);
    return row;
  }

  throw new Error(
    `exhausted project port leases; no free slot among ${PROJECT_PORT_LEASE_CAPACITY} reserved project port pairs`,
  );
}

export function releaseProjectPortLease(project_id: string): void {
  ensureProjectPortLeasesTable();
  const db = getDatabase();
  db.prepare("DELETE FROM project_port_leases WHERE project_id=?").run(
    project_id,
  );
}
