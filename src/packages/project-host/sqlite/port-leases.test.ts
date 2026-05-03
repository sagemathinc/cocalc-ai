/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { closeDatabase } from "@cocalc/lite/hub/sqlite/database";
import {
  acquireProjectPortLease,
  getProjectPortLease,
  HTTP_PORT_LEASE_START,
  releaseProjectPortLease,
  SSH_PORT_LEASE_START,
} from "./port-leases";
import { deleteProjectLocal, upsertProject } from "./projects";

describe("project port lease sqlite", () => {
  const prevFilename = process.env.COCALC_LITE_SQLITE_FILENAME;
  const projectA = "1fc5e846-547c-4c78-baa3-d0528685eea0";
  const projectB = "72d1e771-99c0-47b2-b8b0-a29d882646a8";
  const projectC = "502bcc4e-f2b4-4450-8646-75d1c2655c01";

  beforeEach(() => {
    process.env.COCALC_LITE_SQLITE_FILENAME = ":memory:";
    closeDatabase();
  });

  afterEach(() => {
    closeDatabase();
    if (prevFilename == null) {
      delete process.env.COCALC_LITE_SQLITE_FILENAME;
    } else {
      process.env.COCALC_LITE_SQLITE_FILENAME = prevFilename;
    }
  });

  it("reuses a stable lease for the same project", () => {
    upsertProject({ project_id: projectA, state: "opened" });
    const first = acquireProjectPortLease(projectA);
    const second = acquireProjectPortLease(projectA);

    expect(second).toMatchObject(first);
    expect(first.ssh_port).toBe(SSH_PORT_LEASE_START);
    expect(first.http_port).toBe(HTTP_PORT_LEASE_START);
  });

  it("avoids ports currently used by running projects without leases", () => {
    upsertProject({
      project_id: projectA,
      state: "running",
      ssh_port: SSH_PORT_LEASE_START,
      http_port: HTTP_PORT_LEASE_START,
    });
    upsertProject({ project_id: projectB, state: "opened" });

    const lease = acquireProjectPortLease(projectB);

    expect(lease.ssh_port).toBe(SSH_PORT_LEASE_START + 1);
    expect(lease.http_port).toBe(HTTP_PORT_LEASE_START + 1);
  });

  it("rotates to a fresh lease when requested", () => {
    upsertProject({ project_id: projectA, state: "opened" });
    upsertProject({ project_id: projectB, state: "opened" });
    acquireProjectPortLease(projectB);

    const first = acquireProjectPortLease(projectA);
    const rotated = acquireProjectPortLease(projectA, { rotate: true });

    expect(rotated.ssh_port).not.toBe(first.ssh_port);
    expect(rotated.http_port).not.toBe(first.http_port);
  });

  it("releases the lease when the local project row is deleted", () => {
    upsertProject({ project_id: projectC, state: "opened" });
    acquireProjectPortLease(projectC);
    expect(getProjectPortLease(projectC)).toBeDefined();

    deleteProjectLocal(projectC);

    expect(getProjectPortLease(projectC)).toBeUndefined();
  });

  it("explicit release removes the lease row", () => {
    upsertProject({ project_id: projectA, state: "opened" });
    acquireProjectPortLease(projectA);

    releaseProjectPortLease(projectA);

    expect(getProjectPortLease(projectA)).toBeUndefined();
  });
});
