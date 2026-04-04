/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { db } from "@cocalc/database";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { callback_opts } from "@cocalc/util/async-utils";
import { uuid } from "@cocalc/util/misc";

import { rebuildAccountCollaboratorIndex } from "../account-collaborator-index";
import type { PostgreSQL } from "../types";

describe("collaborator query methods", () => {
  const database: PostgreSQL = db();

  const getCollaboratorIdsLegacy = callback_opts(
    database.get_collaborator_ids.bind(database),
  ) as (opts: { account_id: string }) => Promise<string[]>;
  const getCollaboratorsLegacy = callback_opts(
    database.get_collaborators.bind(database),
  ) as (opts: { project_id: string }) => Promise<string[]>;

  async function getCollaboratorIds(opts: {
    account_id: string;
  }): Promise<string[]> {
    return getCollaboratorIdsLegacy(opts);
  }

  async function getCollaborators(opts: {
    project_id: string;
  }): Promise<string[]> {
    return getCollaboratorsLegacy(opts);
  }

  async function insertProject(
    project_id: string,
    users: Record<string, unknown>,
  ): Promise<void> {
    const pool = getPool();
    await pool.query(
      "INSERT INTO projects (project_id, title, users, last_edited) VALUES ($1, $2, $3, $4)",
      [project_id, "Test Project", JSON.stringify(users), new Date()],
    );
  }

  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    delete process.env.COCALC_ACCOUNT_COLLABORATOR_INDEX_COLLABORATOR_READS;
    const pool = getPool();
    await pool.query("DELETE FROM projects");
    await pool.query("DELETE FROM account_collaborator_index");
    await pool.query("DELETE FROM accounts");
  });

  afterAll(async () => {
    await testCleanup();
  });

  it("get_collaborator_ids returns distinct collaborators across projects", async () => {
    const account_id = uuid();
    const collaboratorA = uuid();
    const collaboratorB = uuid();
    const collaboratorC = uuid();

    await insertProject(uuid(), {
      [account_id]: { group: "collaborator" },
      [collaboratorA]: { group: "owner" },
      [collaboratorB]: { group: "collaborator" },
    });
    await insertProject(uuid(), {
      [account_id]: { group: "collaborator" },
      [collaboratorB]: { group: "collaborator" },
    });
    await insertProject(uuid(), {
      [collaboratorC]: { group: "collaborator" },
    });

    const results = await getCollaboratorIds({ account_id });
    const resultSet = new Set(results);

    expect(resultSet.has(account_id)).toBe(true);
    expect(resultSet.has(collaboratorA)).toBe(true);
    expect(resultSet.has(collaboratorB)).toBe(true);
    expect(resultSet.has(collaboratorC)).toBe(false);
    expect(resultSet.size).toBe(3);
    expect(results.length).toBe(resultSet.size);
  });

  it("get_collaborators returns all users for a project", async () => {
    const project_id = uuid();
    const collaboratorA = uuid();
    const collaboratorB = uuid();
    const collaboratorC = uuid();

    await insertProject(project_id, {
      [collaboratorA]: { group: "owner" },
      [collaboratorB]: { group: "collaborator" },
    });
    await insertProject(uuid(), {
      [collaboratorC]: { group: "collaborator" },
    });

    const results = await getCollaborators({ project_id });
    const resultSet = new Set(results);

    expect(resultSet.has(collaboratorA)).toBe(true);
    expect(resultSet.has(collaboratorB)).toBe(true);
    expect(resultSet.has(collaboratorC)).toBe(false);
    expect(resultSet.size).toBe(2);
  });

  it("get_collaborator_ids uses account_collaborator_index when enabled", async () => {
    process.env.COCALC_ACCOUNT_COLLABORATOR_INDEX_COLLABORATOR_READS = "prefer";
    const account_id = uuid();
    const collaboratorA = uuid();
    const collaboratorB = uuid();

    await getPool().query(
      `INSERT INTO accounts
         (account_id, first_name, last_name, created, email_address, home_bay_id)
       VALUES
         ($1, 'Local', 'User', NOW(), 'local@example.com', 'bay-0'),
         ($2, 'Alice', 'A', NOW(), 'alice@example.com', 'bay-0'),
         ($3, 'Bob', 'B', NOW(), 'bob@example.com', 'bay-0')`,
      [account_id, collaboratorA, collaboratorB],
    );
    await insertProject(uuid(), {
      [account_id]: { group: "owner" },
      [collaboratorA]: { group: "collaborator" },
      [collaboratorB]: { group: "collaborator" },
    });

    await rebuildAccountCollaboratorIndex({
      account_id,
      bay_id: "bay-0",
      dry_run: false,
    });

    const results = await getCollaboratorIds({ account_id });
    expect(new Set(results)).toEqual(
      new Set([account_id, collaboratorA, collaboratorB]),
    );
  });
});
