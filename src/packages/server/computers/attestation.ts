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
// The privacy epoch is projects.runtime_authority_revision: a trigger bumps it
// atomically with every change to the users map, whatever code path changes
// it (database/postgres/schema/project-runtime-authority-revision.ts).

import getPool from "@cocalc/database/pool";
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
  const { rows } = await getPool().query<{
    users: unknown;
    runtime_authority_revision: string | number | null;
    deleted: boolean | null;
  }>(
    `SELECT users, runtime_authority_revision, deleted
       FROM projects WHERE project_id=$1`,
    [project_id],
  );
  const row = rows[0];
  if (row == null) throw new Error("no such project on this bay");
  const eligible =
    !row.deleted && projectEligibleForComputers(row.users, account_id);
  const payload: ProjectAttestation = parseProjectAttestation({
    type: "cocalc-project-attestation",
    version: 1,
    site: await computersSite(),
    cluster_id: getConfiguredClusterId(),
    project_id,
    project_bay_id: getConfiguredBayId(),
    eligible,
    privacy_epoch: Number(row.runtime_authority_revision ?? 0),
    account_id,
    home_bay_id,
    issued_at: now,
    not_after: now + ATTESTATION_MS,
  });
  return await signAsBay(SIGNED_KINDS.attestation, payload);
}
