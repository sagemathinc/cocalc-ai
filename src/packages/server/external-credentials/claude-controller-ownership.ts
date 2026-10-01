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
  acquired_at: string;
  released?: boolean;
  retired?: string[];
}

export function sameClaudeControllerOwner(
  a: ClaudeControllerOwner,
  b?: ClaudeControllerOwner,
): boolean {
  return (
    !!b &&
    a.holder === b.holder &&
    a.host_id === b.host_id &&
    a.project_id === b.project_id
  );
}

/** A durable owner, NOT a TTL lease: expiry cannot fence provider-side refresh. */
export async function manageClaudeControllerOwnership(
  request: ClaudeControllerOwnershipRequest,
): Promise<ClaudeControllerOwnershipResult> {
  const { credential_id, owner_account_id, operation, ...owner } = request;
  if (
    ![
      credential_id,
      owner_account_id,
      owner.holder,
      owner.host_id,
      owner.project_id,
    ].every(isValidUUID) ||
    !["acquire", "release"].includes(operation)
  )
    throw Error("Invalid Claude controller ownership request");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      controller_ownership: Ownership | null;
      revoked: Date | null;
    }>(
      `SELECT controller_ownership, revoked FROM external_credentials
       WHERE id=$1 AND owner_account_id=$2 AND scope='account'
         AND provider='anthropic' AND kind=$3 FOR UPDATE`,
      [credential_id, owner_account_id, CLAUDE_SUBSCRIPTION_KIND],
    );
    const row = rows[0];
    if (!row || (operation === "acquire" && row.revoked))
      throw Error("Claude subscription is unavailable or revoked");
    const stored = row.controller_ownership;
    let result: ClaudeControllerOwnershipResult;
    if (operation === "release") {
      // Remember stopped holders even if acquisition acknowledgement was lost
      // or another holder has since acquired. A delayed acquire cannot revive it.
      const retired = [...new Set([...(stored?.retired ?? []), owner.holder])];
      const next =
        stored && !sameClaudeControllerOwner(stored, owner)
          ? { ...stored, retired }
          : {
              ...owner,
              acquired_at: stored?.acquired_at ?? new Date().toISOString(),
              released: true,
              retired,
            };
      await client.query(
        "UPDATE external_credentials SET controller_ownership=$2 WHERE id=$1",
        [credential_id, next],
      );
      result = "released";
    } else if (stored?.retired?.includes(owner.holder)) {
      result = "released";
    } else if (stored && sameClaudeControllerOwner(stored, owner)) {
      // A lost acquisition/release acknowledgement must not resurrect a stopped controller.
      result = stored.released ? "released" : "acquired";
    } else if (stored && !stored.released) {
      result = "busy";
    } else {
      await client.query(
        "UPDATE external_credentials SET controller_ownership=$2 WHERE id=$1",
        [
          credential_id,
          {
            ...owner,
            acquired_at: new Date().toISOString(),
            retired: stored?.retired ?? [],
          },
        ],
      );
      result = "acquired";
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Must be called in the payload writer's transaction, before modifying the row. */
export async function assertClaudeControllerWriter(
  client: PoolClient,
  id: string,
  owner?: ClaudeControllerOwner,
  expectedPayloadSha256?: string,
): Promise<void> {
  const { rows } = await client.query<{
    controller_ownership: Ownership | null;
  }>(
    `SELECT controller_ownership FROM external_credentials
     WHERE id=$1 AND scope='account' AND provider='anthropic' AND kind=$2 FOR UPDATE`,
    [id, CLAUDE_SUBSCRIPTION_KIND],
  );
  const stored = rows[0]?.controller_ownership;
  if (!stored) {
    if (owner) throw Error(CLAUDE_CONTROLLER_FENCED);
    return;
  }
  if (stored.released && !owner && !expectedPayloadSha256) return; // Explicit idle reconnect.
  if (stored.released || !sameClaudeControllerOwner(stored, owner))
    throw Error(CLAUDE_CONTROLLER_FENCED);
}
