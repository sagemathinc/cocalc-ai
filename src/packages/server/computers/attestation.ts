/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The project's bay attests, signed and for at most 30 seconds, whether a
// project may use computers right now, at which privacy epoch. Tickets carry
// the attestation; daemons verify it themselves, so admission after a
// collaborator is added is bounded even when every invalidation is lost.
// Plan: src/.agents/computers-plan-2026-10-11.md (decision 23).
//
// Eligible: not deleted, and the project's users map has exactly one entry,
// its owner, who is the account asking. Any other entry (collaborator,
// viewer, owner) makes it ineligible. Public shares don't matter (William,
// Oct 12 2026): they let nobody act in the project.
//
// The privacy epoch is runtime_authority_revision, bumped by a trigger on
// every change to the users map, whatever code path makes it
// (database/postgres/schema/project-runtime-authority-revision.ts), and
// copied with the project when it is rehomed, so it never goes back.
//
// Only the owning bay attests, under the project-rehome fence: never while a
// rehome runs, and never once this bay's row says another bay owns it. An
// attestation made just before a rehome starts is good for at most 30 s, and
// a ticket's start-by can't outlive it.

import getPool from "@cocalc/database/pool";
import { assertProjectNotRehoming } from "@cocalc/database/postgres/project-rehome-fence";
import {
  MAX_ATTESTATION_MS,
  parseProjectAttestation,
  SIGNED_KINDS,
  type ProjectAttestation,
  type SignedEnvelope,
} from "@cocalc/util/computers/protocol";
import { isValidUUID } from "@cocalc/util/misc";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterId } from "@cocalc/server/cluster-config";
import { signAsBay } from "./signing-keys";
import { computersSite } from "./site";

export const ATTESTATION_MS = MAX_ATTESTATION_MS;

export function projectEligibleForComputers(
  users: unknown,
  account_id: string,
): boolean {
  if (users == null || typeof users !== "object" || Array.isArray(users)) {
    return false;
  }
  const entries = Object.entries(users as Record<string, any>);
  if (entries.length !== 1) return false;
  const [id, info] = entries[0];
  const group = typeof info === "string" ? info : info?.group;
  return id === account_id && group === "owner";
}

type Db = {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
};

async function withProjectAttestationFence<T>(
  project_id: string,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await assertProjectNotRehoming({
      db: client,
      project_id,
      action: "attest a project for computers",
    });
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Attest a project owned by THIS bay. The caller routes to the project's
 * owning bay; this function must only run there.
 */
export async function attestProjectLocal({
  project_id,
  account_id,
  home_bay_id,
  now = Date.now(),
}: {
  project_id: string;
  account_id: string;
  home_bay_id: string;
  now?: number;
}): Promise<SignedEnvelope<ProjectAttestation>> {
  if (!isValidUUID(project_id) || !isValidUUID(account_id)) {
    throw new Error("invalid project or account id");
  }
  // Under the project-rehome fence (the advisory lock a rehome takes when it
  // starts): no attestation while a rehome runs, and only while this bay
  // still owns the project.
  const bay_id = getConfiguredBayId();
  const row = await withProjectAttestationFence(project_id, async (db) => {
    // Lock the row first, in its own statement (under READ COMMITTED a
    // statement that waits for a lock keeps its old snapshot for anything
    // else it reads); then read it.
    await db.query("SELECT 1 FROM projects WHERE project_id=$1 FOR SHARE", [
      project_id,
    ]);
    const { rows } = await db.query(
      `SELECT users, deleted, owning_bay_id,
              COALESCE(runtime_authority_revision, 0)::text AS authority
         FROM projects WHERE project_id=$1`,
      [project_id],
    );
    const row = rows[0];
    return row;
  });
  if (row == null) throw new Error("no such project on this bay");
  const owner = `${row.owning_bay_id ?? ""}`.trim() || bay_id;
  if (owner !== bay_id) {
    throw new Error("this bay no longer owns the project");
  }
  // Decision 23: exactly one collaborator, the owner.
  const eligible =
    !row.deleted && projectEligibleForComputers(row.users, account_id);
  const privacy_epoch = Number(row.authority);
  const payload: ProjectAttestation = parseProjectAttestation({
    type: "cocalc-project-attestation",
    version: 1,
    site: await computersSite(),
    cluster_id: getConfiguredClusterId(),
    project_id,
    project_bay_id: bay_id,
    eligible,
    privacy_epoch,
    account_id,
    home_bay_id,
    issued_at: now,
    not_after: now + ATTESTATION_MS,
  });
  return await signAsBay(SIGNED_KINDS.attestation, payload);
}

/**
 * Why a project can't use computers, for the agent's error message (null if
 * it can). A plain read: the signed attestation alone decides.
 */
export async function explainProjectIneligibility({
  project_id,
  account_id,
}: {
  project_id: string;
  account_id: string;
}): Promise<string | null> {
  if (!isValidUUID(project_id) || !isValidUUID(account_id)) {
    throw new Error("invalid project or account id");
  }
  const { rows } = await getPool().query(
    `SELECT users, deleted FROM projects WHERE project_id=$1`,
    [project_id],
  );
  const row = rows[0];
  if (row == null) return "no such project";
  if (row.deleted) return "this project has been deleted";
  if (!projectEligibleForComputers(row.users, account_id)) {
    return "computers can only be used from a project whose only collaborator is you (create a private project for this agent)";
  }
  return null;
}
