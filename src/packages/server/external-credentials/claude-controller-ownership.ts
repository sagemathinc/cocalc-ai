/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";
import { CLAUDE_SUBSCRIPTION_KIND } from "@cocalc/util/ai/external-credential-profiles";
import { CLAUDE_CONTROLLER_FENCED } from "@cocalc/util/ai/claude-controller-ownership";
import type {
  ClaudeControllerOwner,
  ClaudeControllerOwnershipRequest,
  ClaudeControllerOwnershipResult,
} from "@cocalc/util/ai/claude-controller-ownership";

interface Ownership extends ClaudeControllerOwner {
  credential_id?: string;
  acquired_at: string;
  released?: boolean;
  retired?: string[];
  generation?: number;
  purpose?: "controller" | "sign-in";
  state?: "active" | "released";
  transitioned_at?: string;
}

export function sameClaudeControllerOwner(
  a: ClaudeControllerOwner,
  b?: ClaudeControllerOwner,
): boolean {
  return (
    !!b &&
    a.holder === b.holder &&
    a.host_id === b.host_id &&
    a.project_id === b.project_id &&
    (!a.runtime_id || a.runtime_id === b.runtime_id)
  );
}

// Identical to the credential store's selector lock, including empty null fields.
async function lockAccount(client: PoolClient, account: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `external-credential:anthropic:${CLAUDE_SUBSCRIPTION_KIND}:account:${account}::`,
  ]);
}

async function readOwnership(
  client: PoolClient,
  account: string,
): Promise<Ownership | undefined> {
  const { rows } = await client.query<{ ownership: Ownership }>(
    "SELECT ownership FROM claude_controller_ownership WHERE account_id=$1 FOR UPDATE",
    [account],
  );
  return rows[0]?.ownership;
}

/** A durable account/profile owner, NOT a TTL lease. No credential row can bypass it. */
export async function manageClaudeControllerOwnership(
  request: ClaudeControllerOwnershipRequest,
): Promise<ClaudeControllerOwnershipResult> {
  const {
    credential_id,
    owner_account_id,
    operation,
    purpose = "controller",
    ...owner
  } = request;
  if (
    ![
      owner_account_id,
      owner.holder,
      owner.host_id,
      owner.project_id,
      ...(credential_id == null ? [] : [credential_id]),
    ].every(isValidUUID) ||
    !["acquire", "release"].includes(operation) ||
    !["controller", "sign-in"].includes(purpose) ||
    (owner.runtime_id != null &&
      !/^\d+:[0-9a-f-]{36}:\d+$/.test(owner.runtime_id))
  )
    throw Error("Invalid Claude controller ownership request");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockAccount(client, owner_account_id);
    if (operation === "acquire" && credential_id) {
      const { rows } = await client.query(
        `SELECT id FROM external_credentials WHERE id=$1 AND owner_account_id=$2
         AND scope='account' AND provider='anthropic' AND kind=$3 AND revoked IS NULL`,
        [credential_id, owner_account_id, CLAUDE_SUBSCRIPTION_KIND],
      );
      if (!rows.length)
        throw Error("Claude subscription is unavailable or revoked");
    }
    const stored = await readOwnership(client, owner_account_id);
    // During upgrade, revoked rows and every legacy owner remain a fence.
    const { rows: legacy } = await client.query<{
      id: string;
      controller_ownership: Ownership;
    }>(
      `SELECT id, controller_ownership FROM external_credentials WHERE owner_account_id=$1
       AND scope='account' AND provider='anthropic' AND kind=$2
       AND controller_ownership IS NOT NULL FOR UPDATE`,
      [owner_account_id, CLAUDE_SUBSCRIPTION_KIND],
    );
    const legacyOwners = legacy.map((row) => ({
      ...row.controller_ownership,
      credential_id: row.id,
    }));
    const retired = [
      ...new Set([
        ...(stored?.retired ?? []),
        ...legacyOwners.flatMap((value) => value.retired ?? []),
        ...(operation === "release" ? [owner.holder] : []),
      ]),
    ];
    let next = stored;
    let result: ClaudeControllerOwnershipResult;
    if (operation === "release") {
      next =
        stored && !sameClaudeControllerOwner(stored, owner)
          ? { ...stored, retired }
          : {
              ...owner,
              credential_id,
              acquired_at: stored?.acquired_at ?? new Date().toISOString(),
              released: true,
              retired,
              generation: stored?.generation ?? 0,
              purpose: stored?.purpose ?? purpose,
              state: "released",
              transitioned_at: new Date().toISOString(),
            };
      // Exact-holder retirement permits confirmed stopped legacy controllers to
      // release after revocation, without freeing another active owner.
      for (const value of legacyOwners) {
        if (!sameClaudeControllerOwner(value, owner)) continue;
        await client.query(
          `UPDATE external_credentials SET controller_ownership=$3
           WHERE owner_account_id=$1 AND provider='anthropic' AND kind=$2
             AND scope='account' AND controller_ownership->>'holder'=$4`,
          [
            owner_account_id,
            CLAUDE_SUBSCRIPTION_KIND,
            { ...value, released: true, retired },
            owner.holder,
          ],
        );
      }
      result = "released";
    } else if (retired.includes(owner.holder)) result = "released";
    else if (
      legacyOwners.some(
        (value) =>
          !value.released &&
          (!sameClaudeControllerOwner(value, owner) ||
            value.credential_id !== credential_id),
      )
    )
      result = "busy";
    else if (stored && sameClaudeControllerOwner(stored, owner)) {
      result = stored.released
        ? "released"
        : stored.credential_id === credential_id
          ? "acquired"
          : "busy";
    } else if (stored && !stored.released) result = "busy";
    else {
      if (!credential_id) {
        const { rows } = await client.query(
          `SELECT id FROM external_credentials WHERE owner_account_id=$1
           AND scope='account' AND provider='anthropic' AND kind=$2 AND revoked IS NULL LIMIT 1`,
          [owner_account_id, CLAUDE_SUBSCRIPTION_KIND],
        );
        if (rows.length)
          throw Error("Reconnect the existing Claude subscription");
      }
      next = {
        ...owner,
        credential_id,
        acquired_at: new Date().toISOString(),
        retired,
        generation: (stored?.generation ?? 0) + 1,
        purpose,
        state: "active",
        transitioned_at: new Date().toISOString(),
      };
      result = "acquired";
    }
    if (next !== stored)
      await client.query(
        `INSERT INTO claude_controller_ownership(account_id, ownership, updated)
       VALUES($1,$2,NOW()) ON CONFLICT(account_id)
       DO UPDATE SET ownership=EXCLUDED.ownership, updated=NOW()`,
        [owner_account_id, next],
      );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Called under the selector lock in the payload writer's transaction. */
export async function assertClaudeAccountWriter(
  client: PoolClient,
  account: string,
  owner?: ClaudeControllerOwner,
  id?: string,
  expectedPayloadSha256?: string,
): Promise<void> {
  const stored = await readOwnership(client, account);
  const { rows } = await client.query<{
    id: string;
    controller_ownership: Ownership;
  }>(
    `SELECT id, controller_ownership FROM external_credentials WHERE owner_account_id=$1
     AND scope='account' AND provider='anthropic' AND kind=$2
     AND controller_ownership IS NOT NULL FOR UPDATE`,
    [account, CLAUDE_SUBSCRIPTION_KIND],
  );
  if (
    rows.some(
      (row) =>
        !row.controller_ownership.released &&
        (!sameClaudeControllerOwner(row.controller_ownership, owner) ||
          row.id !== id),
    )
  )
    throw Error(CLAUDE_CONTROLLER_FENCED);
  if (!stored) {
    if (
      owner &&
      !rows.some(
        (row) =>
          row.id === id &&
          !row.controller_ownership.released &&
          sameClaudeControllerOwner(row.controller_ownership, owner),
      )
    )
      throw Error(CLAUDE_CONTROLLER_FENCED);
    if (
      expectedPayloadSha256 &&
      rows.some((row) => row.controller_ownership.released)
    )
      throw Error(CLAUDE_CONTROLLER_FENCED);
    return;
  }
  if (stored.released && !owner && !expectedPayloadSha256) return;
  if (
    stored.released ||
    !sameClaudeControllerOwner(stored, owner) ||
    stored.credential_id !== id
  )
    throw Error(CLAUDE_CONTROLLER_FENCED);
}

export async function assertClaudeControllerWriter(
  client: PoolClient,
  id: string,
  owner?: ClaudeControllerOwner,
  expectedPayloadSha256?: string,
): Promise<void> {
  const { rows } = await client.query<{ owner_account_id: string }>(
    `SELECT owner_account_id FROM external_credentials WHERE id=$1
     AND scope='account' AND provider='anthropic' AND kind=$2`,
    [id, CLAUDE_SUBSCRIPTION_KIND],
  );
  if (rows[0])
    await assertClaudeAccountWriter(
      client,
      rows[0].owner_account_id,
      owner,
      id,
      expectedPayloadSha256,
    );
}
