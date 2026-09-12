import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";
import getPool from "@cocalc/database/pool";
import type { Pool, PoolClient } from "@cocalc/database/pool";
import {
  AGENT_IDENTITY_TOKEN_PREFIX,
  type AgentIdentity,
  type AgentMessageReceipt,
} from "@cocalc/conat/agents/protocol";

export function agentMessagingEnabled(): boolean {
  return process.env.COCALC_AGENT_MESSAGING_ENABLED === "1";
}

export function assertAgentMessagingEnabled(): void {
  if (!agentMessagingEnabled())
    throw new Error("agent messaging is not enabled on this bay");
}

export function normalizeAgentPath(path: string): string {
  if (
    typeof path !== "string" ||
    !path.trim() ||
    path.includes("\0") ||
    path.length > 4096
  ) {
    throw new Error("invalid chat path");
  }
  const normalized = posix.resolve("/home/user", path);
  if (!normalized.endsWith(".chat"))
    throw new Error("agent requires a .chat path");
  return normalized;
}

export const hashIdentityToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export type AgentRun = {
  agent_id: string;
  run_id: string;
  account_id: string;
  project_id: string;
  token_hash: string;
  issued_at: Date;
  expires_at: Date;
};

export type AgentDelivery = AgentMessageReceipt & {
  source_agent_id: string;
  grant_id: string;
  body: string;
  guidance: boolean;
  created_at: Date;
};

// Canonical control-plane records. No tokens or message bodies are published
// through project SyncDB or account changefeeds.
export class AgentStore {
  private ready?: Promise<void>;
  constructor(private readonly pool: Pool = getPool()) {}

  async init(): Promise<void> {
    this.ready ??= this.migrate().catch((error) => {
      this.ready = undefined;
      throw error;
    });
    await this.ready;
  }

  private async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(529604,1)");
      const schema = `
      CREATE TABLE IF NOT EXISTS agent_identities (
        agent_id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES projects(project_id),
        path TEXT NOT NULL, thread_id TEXT NOT NULL, name TEXT NOT NULL,
        created_by UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), disabled_at TIMESTAMPTZ,
        disabled_by UUID, UNIQUE(project_id, path, thread_id)
      );
      CREATE TABLE IF NOT EXISTS agent_identity_runs (
        agent_id UUID NOT NULL REFERENCES agent_identities(agent_id), run_id UUID NOT NULL,
        account_id UUID NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        issued_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ, PRIMARY KEY(agent_id, run_id)
      );
      CREATE TABLE IF NOT EXISTS agent_message_grants (
        grant_id UUID PRIMARY KEY,
        source_agent_id UUID NOT NULL REFERENCES agent_identities(agent_id),
        target_agent_id UUID NOT NULL REFERENCES agent_identities(agent_id),
        allow_guidance BOOLEAN NOT NULL DEFAULT false,
        approved_by UUID NOT NULL, reason TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ, revoked_by UUID
      );
      CREATE TABLE IF NOT EXISTS agent_message_inbox (
        message_id UUID PRIMARY KEY, request_id UUID NOT NULL,
        source_agent_id UUID NOT NULL REFERENCES agent_identities(agent_id),
        source_run_id UUID NOT NULL, target_agent_id UUID NOT NULL REFERENCES agent_identities(agent_id),
        grant_id UUID NOT NULL REFERENCES agent_message_grants(grant_id),
        body TEXT NOT NULL CHECK(octet_length(body) <= 32768), guidance BOOLEAN NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','dispatching','dispatched','rejected','unconfirmed')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(source_agent_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS agent_message_pending ON agent_message_inbox(created_at) WHERE state='pending';
      CREATE INDEX IF NOT EXISTS agent_message_grant_targets ON agent_message_grants(source_agent_id,target_agent_id);
      `;
      for (const statement of schema.split(";").filter((s) => s.trim()))
        await client.query(statement);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async query<T extends Record<string, any> = any>(
    sql: string,
    values: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number | null }> {
    await this.init();
    return this.pool.query<T>(sql, values);
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async get(agentId: string): Promise<AgentIdentity> {
    const { rows } = await this.query<AgentIdentity>(
      "SELECT * FROM agent_identities WHERE agent_id=$1",
      [agentId],
    );
    if (!rows[0]) throw new Error("agent not found");
    return rows[0];
  }

  async find(
    projectId: string,
    path: string,
    threadId: string,
  ): Promise<AgentIdentity | undefined> {
    const { rows } = await this.query<AgentIdentity>(
      "SELECT * FROM agent_identities WHERE project_id=$1 AND path=$2 AND thread_id=$3",
      [projectId, normalizeAgentPath(path), threadId],
    );
    return rows[0];
  }

  async issue(agent: AgentIdentity, runId: string, accountId: string) {
    const token =
      AGENT_IDENTITY_TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + 10 * 60_000;
    const { rowCount } = await this.query(
      `
      INSERT INTO agent_identity_runs(agent_id,run_id,account_id,token_hash,expires_at)
      SELECT agent_id,$2,$3,$4,$5 FROM agent_identities WHERE agent_id=$1 AND disabled_at IS NULL
      ON CONFLICT(agent_id,run_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,
        expires_at=EXCLUDED.expires_at
      WHERE agent_identity_runs.ended_at IS NULL AND agent_identity_runs.expires_at>now()
        AND agent_identity_runs.account_id=EXCLUDED.account_id`,
      [
        agent.agent_id,
        runId,
        accountId,
        hashIdentityToken(token),
        new Date(expiresAt),
      ],
    );
    if (!rowCount) throw new Error("agent or run is disabled");
    return {
      agent_id: agent.agent_id,
      run_id: runId,
      token,
      expires_at: expiresAt,
    };
  }

  async activeRun(
    agentId: string,
    runId: string,
    tokenHash?: string,
  ): Promise<AgentRun> {
    const { rows } = await this.query<AgentRun>(
      `SELECT r.*,a.project_id FROM agent_identity_runs r
      JOIN agent_identities a USING(agent_id)
      WHERE r.agent_id=$1 AND r.run_id=$2 AND r.expires_at>now() AND r.ended_at IS NULL
        AND a.disabled_at IS NULL AND ($3::text IS NULL OR r.token_hash=$3)`,
      [agentId, runId, tokenHash ?? null],
    );
    if (!rows[0])
      throw new Error("agent credential is expired, revoked, or invalid");
    return rows[0];
  }

  async authenticate(token: string): Promise<AgentRun> {
    if (!token.startsWith(AGENT_IDENTITY_TOKEN_PREFIX) || token.length > 256)
      throw new Error("invalid agent credential");
    const { rows } = await this.query<{ agent_id: string; run_id: string }>(
      "SELECT agent_id,run_id FROM agent_identity_runs WHERE token_hash=$1",
      [hashIdentityToken(token)],
    );
    if (!rows[0]) throw new Error("invalid agent credential");
    return this.activeRun(
      rows[0].agent_id,
      rows[0].run_id,
      hashIdentityToken(token),
    );
  }

  async claim(): Promise<AgentDelivery | undefined> {
    return this.transaction(async (client) => {
      // Never blindly replay an ambiguous guidance attempt after a worker crash.
      await client.query(
        "UPDATE agent_message_inbox SET state='unconfirmed',updated_at=now() WHERE state='dispatching' AND updated_at<now()-interval '5 minutes'",
      );
      const { rows } =
        await client.query<AgentDelivery>(`UPDATE agent_message_inbox SET state='dispatching',updated_at=now()
        WHERE message_id=(SELECT message_id FROM agent_message_inbox WHERE state='pending'
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
      return rows[0];
    });
  }
}

let singleton: AgentStore | undefined;
export function agentStore(): AgentStore {
  assertAgentMessagingEnabled();
  return (singleton ??= new AgentStore());
}
