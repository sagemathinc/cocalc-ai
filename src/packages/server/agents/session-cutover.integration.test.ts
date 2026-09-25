/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import { PglitePool } from "@cocalc/database/pool/pglite";
import { retireLegacyAgentMessagingAuthority } from "./session-cutover";

function fixture() {
  return new PglitePool();
}

describe("Agent Session authority cutover", () => {
  test("retires legacy authority without changing Session records", async () => {
    const pool = fixture();
    const account = randomUUID();
    for (const sql of [
      `CREATE TABLE agent_personal_grants (
        link_id uuid PRIMARY KEY,
        revoked_at timestamptz,
        paused boolean NOT NULL DEFAULT false
      )`,
      `CREATE TABLE agent_personal_requests (
        request_id uuid PRIMARY KEY,
        state text NOT NULL
      )`,
      `CREATE TABLE agent_rpc_links (
        link_id uuid PRIMARY KEY,
        revoked_at timestamptz
      )`,
      `CREATE TABLE agent_message_grants (
        grant_id uuid PRIMARY KEY,
        revoked_at timestamptz
      )`,
      `CREATE TABLE agent_external_installations (
        installation_id uuid PRIMARY KEY,
        state text NOT NULL,
        destinations jsonb NOT NULL DEFAULT '[]'::jsonb
      )`,
      `CREATE TABLE agent_sessions (
        agent_session_id uuid PRIMARY KEY,
        account_id uuid NOT NULL
      )`,
    ]) {
      await pool.query(sql);
    }
    await pool.query("INSERT INTO agent_personal_grants(link_id) VALUES($1)", [
      randomUUID(),
    ]);
    await pool.query(
      "INSERT INTO agent_personal_requests(request_id,state) VALUES($1,'pending')",
      [randomUUID()],
    );
    await pool.query("INSERT INTO agent_rpc_links(link_id) VALUES($1)", [
      randomUUID(),
    ]);
    await pool.query("INSERT INTO agent_message_grants(grant_id) VALUES($1)", [
      randomUUID(),
    ]);
    const legacyExternal = randomUUID();
    const sessionExternal = randomUUID();
    await pool.query(
      `INSERT INTO agent_external_installations(installation_id,state,destinations)
       VALUES($1,'active','[{"agent_id":"legacy"}]'),($2,'active','[]')`,
      [legacyExternal, sessionExternal],
    );
    const session = randomUUID();
    await pool.query(
      "INSERT INTO agent_sessions(agent_session_id,account_id) VALUES($1,$2)",
      [session, account],
    );

    await retireLegacyAgentMessagingAuthority(pool);
    await retireLegacyAgentMessagingAuthority(pool);

    expect(
      (
        await pool.query(
          "SELECT paused,revoked_at IS NOT NULL AS revoked FROM agent_personal_grants",
        )
      ).rows,
    ).toEqual([{ paused: true, revoked: true }]);
    expect(
      (await pool.query("SELECT state FROM agent_personal_requests")).rows,
    ).toEqual([{ state: "invalidated" }]);
    expect(
      (
        await pool.query(
          "SELECT revoked_at IS NOT NULL AS revoked FROM agent_rpc_links",
        )
      ).rows,
    ).toEqual([{ revoked: true }]);
    expect(
      (
        await pool.query(
          "SELECT revoked_at IS NOT NULL AS revoked FROM agent_message_grants",
        )
      ).rows,
    ).toEqual([{ revoked: true }]);
    expect(
      (
        await pool.query(
          "SELECT installation_id,state FROM agent_external_installations ORDER BY installation_id",
        )
      ).rows,
    ).toEqual(
      [
        { installation_id: legacyExternal, state: "revoked" },
        { installation_id: sessionExternal, state: "active" },
      ].sort((a, b) => a.installation_id.localeCompare(b.installation_id)),
    );
    expect((await pool.query("SELECT * FROM agent_sessions")).rows).toEqual([
      { agent_session_id: session, account_id: account },
    ]);
    await pool.end();
  });

  test("does nothing on a fresh Session-only schema", async () => {
    const pool = fixture();
    await pool.query(
      "CREATE TABLE agent_sessions(agent_session_id uuid PRIMARY KEY)",
    );
    await expect(
      retireLegacyAgentMessagingAuthority(pool),
    ).resolves.toBeUndefined();
    await pool.end();
  });
});
