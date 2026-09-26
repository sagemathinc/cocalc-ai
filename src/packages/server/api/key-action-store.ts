/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { Pool, PoolClient } from "@cocalc/database/pool";
import {
  assertAccountNotRehoming,
  assertAccountWriteOnHomeBay,
} from "@cocalc/database/postgres/account-rehome-fence";
import {
  API_KEY_ACTION_TTL_MS,
  MAX_PENDING_API_KEY_ACTIONS,
  normalizeApiKeyActionBinding,
  normalizeApiKeyActionRequest,
} from "@cocalc/util/api-key-management";
import type { ApiKeyActionReview } from "@cocalc/util/api-key-management";

type Authorize = (
  client: PoolClient,
  review: ApiKeyActionReview,
) => Promise<void>;

// Internal persistence only: callers must resolve account home and supply real
// authorization checks. No endpoint or capability exposes this store yet.
export class ApiKeyActionStore {
  constructor(private readonly pool: Pool) {}

  async ensureSchema(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS api_key_action_requests (
      account_id UUID NOT NULL,
      request_id UUID NOT NULL,
      review JSONB NOT NULL,
      expires_at BIGINT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','rejected','executed')),
      PRIMARY KEY(account_id,request_id)
    )`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS api_key_action_pending_idx
      ON api_key_action_requests(account_id,expires_at) WHERE status='pending'`);
  }

  private async transaction<T>(
    accountId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await assertAccountNotRehoming({
        db: client,
        account_id: accountId,
        action: "manage API key actions",
      });
      await assertAccountWriteOnHomeBay({
        db: client,
        account_id: accountId,
        action: "manage API key actions",
      });
      // Serialize per-account admission so concurrent requests cannot race the cap.
      const locked = await client.query(
        "SELECT account_id FROM accounts WHERE account_id=$1::UUID FOR UPDATE",
        [accountId],
      );
      if (!locked.rows.length)
        throw new Error("API key action owner is unavailable");
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

  async create(
    review: ApiKeyActionReview,
    authorize: Authorize,
  ): Promise<ApiKeyActionReview> {
    const request = normalizeApiKeyActionRequest({
      request_id: review.request_id,
      action: review.action,
    });
    const binding = normalizeApiKeyActionBinding(review.binding);
    if (
      binding.target_key_id !== request.action.target_key_id ||
      review.status !== "pending" ||
      !Number.isSafeInteger(review.created_at) ||
      review.created_at < 0 ||
      !Number.isSafeInteger(review.expires_at) ||
      review.expires_at <= review.created_at ||
      review.expires_at - review.created_at > API_KEY_ACTION_TTL_MS ||
      typeof review.target_name !== "string" ||
      review.target_name.length > 128 ||
      typeof review.target_trunc !== "string" ||
      review.target_trunc.length > 16
    ) {
      throw new Error("invalid API key action review");
    }
    const canonical: ApiKeyActionReview = {
      ...request,
      binding,
      target_name: review.target_name,
      target_trunc: review.target_trunc,
      created_at: review.created_at,
      expires_at: review.expires_at,
      status: "pending",
    };
    return this.transaction(binding.account_id, async (client) => {
      const previous = await client.query(
        "SELECT review,status FROM api_key_action_requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE",
        [binding.account_id, request.request_id],
      );
      if (previous.rows.length) {
        const stored = this.decode(previous.rows[0]);
        if (
          JSON.stringify(stored.binding) !== JSON.stringify(binding) ||
          JSON.stringify(stored.action) !== JSON.stringify(request.action)
        ) {
          throw new Error(
            "API key action request id was already used with different authority or arguments",
          );
        }
        await authorize(client, stored);
        return stored;
      }
      await authorize(client, canonical);
      const { rows } = await client.query(
        `SELECT count(*)::INTEGER AS count FROM api_key_action_requests
        WHERE account_id=$1 AND status='pending' AND expires_at > extract(epoch from clock_timestamp())*1000`,
        [binding.account_id],
      );
      if (Number(rows[0].count) >= MAX_PENDING_API_KEY_ACTIONS)
        throw new Error("too many pending API key actions");
      await this.assertLive(client, canonical);
      await client.query(
        `INSERT INTO api_key_action_requests(account_id,request_id,review,expires_at,status)
        VALUES($1,$2,$3::JSONB,$4,'pending')`,
        [
          binding.account_id,
          request.request_id,
          JSON.stringify(canonical),
          canonical.expires_at,
        ],
      );
      return canonical;
    });
  }

  async decide({
    reviewed,
    decision,
    authorize,
    execute,
  }: {
    reviewed: ApiKeyActionReview;
    decision: "reject" | "execute";
    authorize: Authorize;
    execute: Authorize;
  }): Promise<ApiKeyActionReview> {
    if (decision !== "reject" && decision !== "execute")
      throw new Error("invalid API key action decision");
    const binding = normalizeApiKeyActionBinding(reviewed.binding);
    const request = normalizeApiKeyActionRequest({
      request_id: reviewed.request_id,
      action: reviewed.action,
    });
    return this.transaction(binding.account_id, async (client) => {
      const { rows } = await client.query(
        "SELECT review,status FROM api_key_action_requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE",
        [binding.account_id, request.request_id],
      );
      if (!rows.length) throw new Error("API key action not found");
      const stored = this.decode(rows[0]);
      if (
        JSON.stringify(stored.binding) !== JSON.stringify(binding) ||
        JSON.stringify(stored.action) !== JSON.stringify(request.action) ||
        stored.target_name !== reviewed.target_name ||
        stored.target_trunc !== reviewed.target_trunc ||
        stored.created_at !== reviewed.created_at ||
        stored.expires_at !== reviewed.expires_at
      ) {
        throw new Error("API key action review changed");
      }
      await authorize(client, stored);
      const desired = decision === "execute" ? "executed" : "rejected";
      if (stored.status === desired) return stored;
      if (stored.status !== "pending")
        throw new Error("API key action already decided");
      await this.assertLive(client, stored);
      if (decision === "execute") {
        await execute(client, stored);
        // An action that outlives its approval rolls back with its mutation.
        await this.assertLive(client, stored);
      }
      await client.query(
        "UPDATE api_key_action_requests SET status=$3 WHERE account_id=$1 AND request_id=$2",
        [binding.account_id, request.request_id, desired],
      );
      return { ...stored, status: desired };
    });
  }

  private decode(row: {
    review: ApiKeyActionReview;
    status: ApiKeyActionReview["status"];
  }): ApiKeyActionReview {
    // JSONB does not preserve object key order. Restore canonical order before
    // comparing the immutable action and binding with the reviewed values.
    const request = normalizeApiKeyActionRequest({
      request_id: row.review.request_id,
      action: row.review.action,
    });
    return {
      ...row.review,
      ...request,
      binding: normalizeApiKeyActionBinding(row.review.binding),
      status: row.status,
    };
  }

  private async assertLive(
    client: PoolClient,
    review: ApiKeyActionReview,
  ): Promise<void> {
    const { rows } = await client.query(
      `SELECT $1::BIGINT > extract(epoch from clock_timestamp())*1000
        AND $2::BIGINT <= extract(epoch from clock_timestamp())*1000 AS live`,
      [review.expires_at, review.created_at],
    );
    if (!rows[0]?.live) throw new Error("API key action expired");
  }
}
