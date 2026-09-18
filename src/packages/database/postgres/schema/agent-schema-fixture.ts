/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { Pool } from "pg";
import { PglitePool } from "@cocalc/database/pool/pglite";

export interface AgentSchemaFixture {
  query: (...args: any[]) => Promise<any>;
  end: () => Promise<void>;
}

export function agentSchemaBackend(): "postgres" | "pglite" {
  return process.env.COCALC_AGENT_SCHEMA_PG_SOCKET ? "postgres" : "pglite";
}

/** Optional real-PostgreSQL coverage; never accepts an existing test database. */
export async function createAgentSchemaFixture(): Promise<AgentSchemaFixture> {
  const socket = process.env.COCALC_AGENT_SCHEMA_PG_SOCKET;
  if (!socket) return new PglitePool();
  if (!socket.startsWith("/"))
    throw new Error("expected an absolute Unix socket directory");
  const config = {
    host: socket,
    port: 55439,
    user: userInfo().username,
    password: "",
    max: 1,
  };
  const name = `agent_schema_qa_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ ...config, database: "postgres" });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  const db = new Pool({ ...config, database: name });
  return {
    query: (text, values) => db.query(text, values),
    end: async () => {
      try {
        await db.end();
        await admin.query(`DROP DATABASE "${name}"`);
      } finally {
        await admin.end();
      }
    },
  };
}
