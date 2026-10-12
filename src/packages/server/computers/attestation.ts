/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The project's bay attests, signed and for at most 30 seconds, whether a
// project may use computers right now, at which privacy epoch. Tickets carry
// the attestation; daemons verify it themselves, so admission after a
// collaborator is added is bounded even when every invalidation is lost.
// Plan: src/.agents/computers-plan-2026-10-11.md ("Privacy fence across
// bays", decision 23).
//
// Eligible: the project's users map has exactly one entry, its owner, who is
// the account asking. Any other entry (collaborator, viewer, owner) makes it
// ineligible.
//
// And nothing of it is shared publicly (an active public_project_paths row).
//
// The privacy epoch is runtime_authority_revision + computers_privacy_revision.
// Triggers bump the first on every change to the users map and the second on
// every change to the project's public shares, whatever code path makes them
// (database/postgres/schema/project-runtime-authority-revision.ts and
// project-computers-privacy.ts). Both are copied with the project when it is
// rehomed, so the epoch never goes back. The same trigger keeps a count of
// active shares on the project row and refuses share changes while a rehome
// of the project runs; the count moves with the project (the share rows
// don't yet), so a moved project that had shares is never attested private.
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
import {
  getConfiguredClusterId,
  isMultiBayCluster,
} from "@cocalc/server/cluster-config";
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

async function publicSharesExist(db: Db): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT to_regclass('public.public_project_paths') AS t",
  );
  return rows[0]?.t != null;
}

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
  // still owns the project. The row is read FOR SHARE together with its
  // public shares, so a share change (whose trigger bumps the row) either
  // happened before or waits for this.
  const bay_id = getConfiguredBayId();
  const row = await withProjectAttestationFence(project_id, async (db) => {
    // Lock the row first, in its own statement. Under READ COMMITTED a
    // statement that waits for a lock re-reads the locked row but keeps its
    // old snapshot for everything else, so reading the shares in the same
    // statement could pair a new epoch with old shares. The next statement
    // starts after any share change that bumped the row has committed.
    await db.query("SELECT 1 FROM projects WHERE project_id=$1 FOR SHARE", [
      project_id,
    ]);
    const sharesTable = await publicSharesExist(db);
    const { rows } = await db.query(
      `SELECT users, deleted, owning_bay_id,
              COALESCE(runtime_authority_revision, 0)::text AS authority,
              COALESCE(computers_privacy_revision, 0)::text AS privacy,
              COALESCE(computers_public_shares, 0) AS public_shares,
              computers_share_state_known AS share_state_known,
              ${
                sharesTable
                  ? `EXISTS (SELECT 1 FROM public_project_paths s
                      WHERE s.project_id = p.project_id
                        AND s.disabled IS NOT TRUE AND s.visibility <> 'disabled')`
                  : "false"
              } AS shared
         FROM projects p WHERE project_id=$1`,
      [project_id],
    );
    const row = rows[0];
    if (row != null && row.share_state_known !== true && !isMultiBayCluster()) {
      // A single-bay site: every share row of the project is here, so the
      // local count is the whole truth. Record it (under the same fence).
      const { rows: counted } = await db.query(
        `UPDATE projects
            SET computers_share_state_known = true,
                computers_public_shares = ${
                  sharesTable
                    ? `(SELECT count(*) FROM public_project_paths s
                         WHERE s.project_id = $1 AND s.disabled IS NOT TRUE
                           AND s.visibility IS DISTINCT FROM 'disabled')`
                    : "0"
                }
          WHERE project_id = $1
          RETURNING computers_public_shares AS public_shares`,
        [project_id],
      );
      row.share_state_known = true;
      row.public_shares = counted[0]?.public_shares ?? row.public_shares;
    }
    return row;
  });
  if (row == null) throw new Error("no such project on this bay");
  const owner = `${row.owning_bay_id ?? ""}`.trim() || bay_id;
  if (owner !== bay_id) {
    throw new Error("this bay no longer owns the project");
  }
  // Decision 23: exactly one collaborator, the owner, and nothing of it
  // shared publicly.
  const eligible =
    !row.deleted &&
    projectEligibleForComputers(row.users, account_id) &&
    !row.shared &&
    // The share count moves with the project; its share rows don't (yet).
    // So a moved project that had shares stays ineligible here, and so does
    // one whose share state isn't known (it may predate the count, or be a
    // copy of such a project), until it is reconciled.
    row.share_state_known === true &&
    Number(row.public_shares) === 0;
  const privacy_epoch = Number(row.authority) + Number(row.privacy);
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
