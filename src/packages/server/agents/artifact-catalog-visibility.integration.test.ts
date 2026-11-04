/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { disableIdentity, registerIdentityLocal } from "./api";

jest.mock("./access", () => ({
  assertActor: async () => {},
  assertLocalAgentProject: async () => {},
  assertAgent: async () => {},
}));
jest.mock("./chat", () => ({
  withAgentChat: async (_agent, fn) => fn({}, { name: "Agent" }),
}));
jest.mock("@cocalc/server/conat/api/dangerous-session-auth", () => ({
  requireDangerousSessionAuth: async () => {},
}));
// Records when catalog readers would be told (after the reset committed).
let mockNudges = 0;
jest.mock("@cocalc/server/artifacts/catalog-readiness", () => ({
  nudgeArtifactCatalogHints: () => {
    mockNudges++;
  },
  afterCatalogCommit: (value) => {
    mockNudges++;
    return value;
  },
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

// Registering or disabling an agent identity changes which artifacts catalog
// readers may see, so it must advance the project's catalog version.
describeDb("agent identity changes reset artifact catalog visibility", () => {
  const account_id = randomUUID();
  const project_id = randomUUID();

  const changes = async () =>
    (
      await getPool().query(
        `SELECT c.op, c.seq FROM artifact_catalog_changes c
         WHERE c.project_id=$1 ORDER BY c.seq`,
        [project_id],
      )
    ).rows.map((row) => ({ op: row.op, seq: Number(row.seq) }));

  beforeAll(async () => {
    const db = getPool();
    await db.query(
      "CREATE TABLE IF NOT EXISTS projects(project_id uuid PRIMARY KEY, users jsonb, owning_bay_id text, deleted boolean)",
    );
    await syncSchema(
      Object.fromEntries(
        [
          "agent_identities",
          "agent_identity_runs",
          "artifact_catalog",
          "artifact_catalog_project_state",
          "artifact_catalog_changes",
        ].map((name) => [name, SCHEMA[name]]),
      ),
    );
    await db.query("INSERT INTO projects(project_id,users) VALUES($1,$2)", [
      project_id,
      { [account_id]: { group: "owner" } },
    ]);
  });
  afterAll(async () => {
    await getPool().end();
  });

  test("register resets once; re-registering the active thread does not", async () => {
    const request = {
      account_id,
      project_id,
      path: "/home/user/work.chat",
      thread_id: "thread",
    };
    const before = mockNudges;
    const agent = await registerIdentityLocal(request);
    expect(agent.thread_id).toBe("thread");
    expect(await changes()).toEqual([{ op: "reset", seq: 1 }]);
    // Readers are told after the transaction that wrote the reset resolved.
    expect(mockNudges).toBe(before + 1);
    await registerIdentityLocal(request);
    expect(await changes()).toEqual([{ op: "reset", seq: 1 }]);
  });

  test("disable resets once; disabling again does not", async () => {
    const agent = (
      await getPool().query(
        "SELECT agent_id FROM agent_identities WHERE project_id=$1",
        [project_id],
      )
    ).rows[0];
    const request = {
      account_id,
      agent_id: agent.agent_id,
      session_hash: "session",
    } as any;
    const before = mockNudges;
    await disableIdentity(request);
    expect(await changes()).toEqual([
      { op: "reset", seq: 1 },
      { op: "reset", seq: 2 },
    ]);
    expect(mockNudges).toBe(before + 1);
    await disableIdentity(request);
    expect(await changes()).toHaveLength(2);
  });

  test("a deleted project refuses the change and writes no catalog rows", async () => {
    const agent = await registerIdentityLocal({
      account_id,
      project_id,
      path: "/home/user/other.chat",
      thread_id: "other",
    });
    expect(await changes()).toHaveLength(3);
    await getPool().query(
      "UPDATE projects SET deleted=TRUE WHERE project_id=$1",
      [project_id],
    );
    try {
      await expect(
        disableIdentity({
          account_id,
          agent_id: agent.agent_id,
          session_hash: "session",
        } as any),
      ).rejects.toThrow("not live on this bay");
      // The whole transaction rolled back: still active, nothing recorded.
      expect(await changes()).toHaveLength(3);
      expect(
        (
          await getPool().query(
            "SELECT disabled_at FROM agent_identities WHERE agent_id=$1",
            [agent.agent_id],
          )
        ).rows[0].disabled_at,
      ).toBeNull();
    } finally {
      await getPool().query(
        "UPDATE projects SET deleted=FALSE WHERE project_id=$1",
        [project_id],
      );
    }
  });
});
