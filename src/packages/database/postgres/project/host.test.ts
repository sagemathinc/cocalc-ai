/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { db } from "@cocalc/database";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { callback_opts } from "@cocalc/util/async-utils";
import { uuid } from "@cocalc/util/misc";
import type { PostgreSQL } from "../types";

describe("project host methods", () => {
  const database: PostgreSQL = db();
  const setProjectHost = callback_opts(
    database.set_project_host.bind(database),
  ) as (opts: { project_id: string; host_id: string }) => Promise<Date>;
  const getProjectHost = callback_opts(
    database.get_project_host.bind(database),
  ) as (opts: { project_id: string }) => Promise<string | undefined>;
  const unsetProjectHost = callback_opts(
    database.unset_project_host.bind(database),
  ) as (opts: { project_id: string }) => Promise<void>;

  async function insertProject(project_id: string): Promise<void> {
    await getPool().query("INSERT INTO projects (project_id) VALUES ($1)", [
      project_id,
    ]);
  }

  async function insertProjectHost(host_id: string, name?: string): Promise<void> {
    await getPool().query(
      "INSERT INTO project_hosts (id, name, created, updated) VALUES ($1, $2, NOW(), NOW())",
      [host_id, name ?? `host-${host_id.slice(0, 8)}`],
    );
  }

  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    const pool = getPool();
    await pool.query("DELETE FROM projects");
    await pool.query("DELETE FROM project_hosts");
  });

  afterAll(async () => {
    await testCleanup();
  });

  describe("set_project_host and get_project_host", () => {
    it("sets and retrieves project host_id", async () => {
      const projectId = uuid();
      const hostId = uuid();
      await insertProject(projectId);
      await insertProjectHost(hostId, "compute-server-01");

      const before = Date.now();
      const assigned = await setProjectHost({
        project_id: projectId,
        host_id: hostId,
      });
      const after = Date.now();

      expect(assigned).toBeInstanceOf(Date);
      expect(assigned.getTime()).toBeGreaterThanOrEqual(before);
      expect(assigned.getTime()).toBeLessThanOrEqual(after);

      const result = await getProjectHost({ project_id: projectId });
      expect(result).toBe(hostId);
    });

    it("returns undefined for project without host_id", async () => {
      const projectId = uuid();
      await insertProject(projectId);

      const result = await getProjectHost({ project_id: projectId });
      expect(result).toBeUndefined();
    });

    it("updates host_id when set multiple times", async () => {
      const projectId = uuid();
      const hostId1 = uuid();
      const hostId2 = uuid();

      await insertProject(projectId);
      await insertProjectHost(hostId1, "server-01");
      await insertProjectHost(hostId2, "server-02");

      const assigned1 = await setProjectHost({
        project_id: projectId,
        host_id: hostId1,
      });
      expect(await getProjectHost({ project_id: projectId })).toBe(hostId1);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const assigned2 = await setProjectHost({
        project_id: projectId,
        host_id: hostId2,
      });
      expect(assigned2.getTime()).toBeGreaterThan(assigned1.getTime());
      expect(await getProjectHost({ project_id: projectId })).toBe(hostId2);
    });

  });

  describe("unset_project_host", () => {
    it("unsets project host_id", async () => {
      const projectId = uuid();
      const hostId = uuid();

      await insertProject(projectId);
      await insertProjectHost(hostId, "compute-server-01");
      await setProjectHost({
        project_id: projectId,
        host_id: hostId,
      });

      expect(await getProjectHost({ project_id: projectId })).toBe(hostId);
      await unsetProjectHost({ project_id: projectId });
      expect(await getProjectHost({ project_id: projectId })).toBeUndefined();
    });

    it("unset succeeds even if host_id was never set", async () => {
      const projectId = uuid();
      await insertProject(projectId);

      await unsetProjectHost({ project_id: projectId });
      expect(await getProjectHost({ project_id: projectId })).toBeUndefined();
    });

    it("can set host_id again after unsetting", async () => {
      const projectId = uuid();
      const hostId1 = uuid();
      const hostId2 = uuid();

      await insertProject(projectId);
      await insertProjectHost(hostId1, "server-01");
      await insertProjectHost(hostId2, "server-02");

      await setProjectHost({ project_id: projectId, host_id: hostId1 });
      await unsetProjectHost({ project_id: projectId });
      await setProjectHost({ project_id: projectId, host_id: hostId2 });

      expect(await getProjectHost({ project_id: projectId })).toBe(hostId2);
    });
  });

  describe("storage behavior", () => {
    it("stores host_id in the projects table", async () => {
      const projectId = uuid();
      const hostId = uuid();

      await insertProject(projectId);
      await insertProjectHost(hostId, "server-01");
      await setProjectHost({ project_id: projectId, host_id: hostId });

      const { rows } = await getPool().query(
        "SELECT host_id FROM projects WHERE project_id = $1",
        [projectId],
      );
      expect(rows[0].host_id).toBe(hostId);
    });
  });
});
