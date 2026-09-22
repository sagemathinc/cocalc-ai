import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";
import getPool from "@cocalc/database/pool";
import type { Pool, PoolClient } from "@cocalc/database/pool";
import {
  AGENT_IDENTITY_TOKEN_PREFIX,
  type AgentIdentity,
} from "@cocalc/conat/agents/protocol";

export function agentMessagingEnabled(): boolean {
  return true;
}

export function assertAgentMessagingEnabled(): void {}

function normalizePath(path: string): string {
  if (
    typeof path !== "string" ||
    !path.trim() ||
    path.includes("\0") ||
    path.length > 4096
  ) {
    throw new Error("invalid chat path");
  }
  return posix.resolve("/home/user", path);
}

export function normalizeAgentPath(path: string): string {
  const normalized = normalizePath(path);
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

// Canonical control-plane records. No tokens or message bodies are published
// through project SyncDB or account changefeeds.
export class AgentStore {
  constructor(private readonly pool: Pool = getPool()) {}

  async query<T extends Record<string, any> = any>(
    sql: string,
    values: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number | null }> {
    return this.pool.query<T>(sql, values);
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
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
    const normalizedPath = normalizePath(path);
    // Some Codex entry points use virtual paths rather than persisted chats.
    // They are not registered messaging agents, so an identity lookup is a miss.
    if (!normalizedPath.endsWith(".chat")) return;
    const { rows } = await this.query<AgentIdentity>(
      "SELECT * FROM agent_identities WHERE project_id=$1 AND path=$2 AND thread_id=$3 AND disabled_at IS NULL",
      [projectId, normalizedPath, threadId],
    );
    return rows[0];
  }

  async issue(
    agent: AgentIdentity,
    runId: string,
    accountId: string,
    recoverExpiredRunId?: string,
  ) {
    const token =
      AGENT_IDENTITY_TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + 10 * 60_000;
    const values = [
      agent.agent_id,
      runId,
      accountId,
      hashIdentityToken(token),
      new Date(expiresAt),
    ];
    let rowCount: number | null;
    if (recoverExpiredRunId) {
      if (recoverExpiredRunId === runId)
        throw new Error("expired identity recovery requires a new run");
      rowCount = await this.transaction(async (db) => {
        const current = await db.query(
          "SELECT agent_id FROM agent_identities WHERE agent_id=$1 AND thread_id=$2 AND disabled_at IS NULL FOR SHARE",
          [agent.agent_id, agent.thread_id],
        );
        if (!current.rows[0]) throw new Error("agent conversation changed");
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `agent-runs:${agent.agent_id}`,
        ]);
        // A recovery may have committed even if its response was lost. Retrying
        // the exact old/new run pair renews that replacement instead of
        // permanently wedging the worker on an unknown outcome.
        const retried = await db.query(
          `UPDATE agent_identity_runs replacement
           SET token_hash=$4,expires_at=$5
           WHERE replacement.agent_id=$1 AND replacement.run_id=$2
             AND replacement.account_id=$3 AND replacement.ended_at IS NULL
             AND EXISTS (
               SELECT 1 FROM agent_identity_runs expired
               WHERE expired.agent_id=$1 AND expired.run_id=$6
                 AND expired.account_id=$3 AND expired.ended_at IS NOT NULL
             )
           RETURNING replacement.run_id`,
          [...values, recoverExpiredRunId],
        );
        if (retried.rows[0]) return 1;
        const count = (
          await db.query(
            "SELECT count(*) AS count FROM agent_identity_runs WHERE agent_id=$1",
            [agent.agent_id],
          )
        ).rows[0];
        if (+count.count >= 10_000)
          throw new Error("agent_identity_run_capacity");
        const recovered = await db.query(
          `UPDATE agent_identity_runs SET ended_at=now()
           WHERE agent_id=$1 AND run_id=$2 AND account_id=$3
             AND ended_at IS NULL AND expires_at<=now()
           RETURNING run_id`,
          [agent.agent_id, recoverExpiredRunId, accountId],
        );
        if (!recovered.rowCount)
          throw new Error("expired identity run is not recoverable");
        const inserted = await db.query(
          `INSERT INTO agent_identity_runs(agent_id,run_id,account_id,token_hash,expires_at)
           SELECT agent_id,$2,$3,$4,$5 FROM agent_identities
           WHERE agent_id=$1 AND disabled_at IS NULL
           RETURNING run_id`,
          values,
        );
        if (!inserted.rows[0]) throw new Error("agent identity is disabled");
        return 1;
      });
    } else {
      rowCount = await this.transaction(async (db) => {
        const current = await db.query(
          "SELECT agent_id FROM agent_identities WHERE agent_id=$1 AND thread_id=$2 AND disabled_at IS NULL FOR SHARE",
          [agent.agent_id, agent.thread_id],
        );
        if (!current.rows[0]) throw new Error("agent conversation changed");
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `agent-runs:${agent.agent_id}`,
        ]);
        const existing = (
          await db.query(
            "SELECT 1 FROM agent_identity_runs WHERE agent_id=$1 AND run_id=$2",
            [agent.agent_id, runId],
          )
        ).rows[0];
        if (!existing) {
          const count = (
            await db.query(
              "SELECT count(*) AS count FROM agent_identity_runs WHERE agent_id=$1",
              [agent.agent_id],
            )
          ).rows[0];
          if (+count.count >= 10_000)
            throw new Error("agent_identity_run_capacity");
        }
        return (
          await db.query(
            `
      INSERT INTO agent_identity_runs(agent_id,run_id,account_id,token_hash,expires_at)
      SELECT agent_id,$2,$3,$4,$5 FROM agent_identities WHERE agent_id=$1 AND disabled_at IS NULL
      ON CONFLICT(agent_id,run_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,
        expires_at=EXCLUDED.expires_at
      WHERE agent_identity_runs.ended_at IS NULL AND agent_identity_runs.expires_at>now()
        AND agent_identity_runs.account_id=EXCLUDED.account_id`,
            values,
          )
        ).rowCount;
      });
      if (!rowCount) {
        const expired = (
          await this.query(
            `SELECT 1 FROM agent_identity_runs
             WHERE agent_id=$1 AND run_id=$2 AND account_id=$3
               AND ended_at IS NULL AND expires_at<=now()`,
            [agent.agent_id, runId, accountId],
          )
        ).rows[0];
        if (expired) throw new Error("agent_identity_run_expired");
      }
    }
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
}

let singleton: AgentStore | undefined;
export function agentStore(): AgentStore {
  assertAgentMessagingEnabled();
  return (singleton ??= new AgentStore());
}
