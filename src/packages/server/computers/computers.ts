/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Paired computers at the account's home bay: list, rename, revoke, and the
// host token a computer asks for every few minutes. Commands never pass
// through here: the computer connects to its project's host directly.
// Design: src/.agents/computers-direct-host-2026-10-16.md.

import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import { getProjectHostAuthTokenPrivateKey } from "@cocalc/backend/data";
import {
  COMPUTER_TOKEN_MAX_TTL_SECONDS,
  issueProjectHostComputerToken,
} from "@cocalc/conat/auth/project-host-token";
import {
  ONLINE_WITHIN_MS,
  type ComputerSummary,
  type HostConnection,
} from "@cocalc/util/computers/api";
import { isValidUUID } from "@cocalc/util/misc";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveHostBay } from "@cocalc/server/inter-bay/directory";
import { resolveHostConnectionLocal } from "@cocalc/server/conat/api/hosts";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
import { assertComputersAuthority, type Queryable } from "./authority";
import { assertComputersEnabled, computersEnabled } from "./enabled";
import {
  ComputerRequestError,
  computerName,
  projectForComputers,
  requireUuid,
  sameText,
  tokenHash,
  transaction,
} from "./requests";

const logger = getLogger("server:computers");

/** Revoked computers per query in computerAccessForHost. */
let ACCESS_PAGE = 1000;
export function setAccessPageForTesting(n: number): void {
  ACCESS_PAGE = n;
}

export type { ComputerSummary };

/** The site says the computer is revoked: its connector ends for good. */
export class ComputerRevokedError extends ComputerRequestError {}
/** Worth trying again later (the project has no host yet, the host is away). */
export class ComputerUnavailableError extends ComputerRequestError {}

function summary(row: any, now = Date.now()): ComputerSummary {
  const connected_at =
    row.connected_at == null ? null : new Date(row.connected_at).valueOf();
  return {
    computer_id: row.computer_id,
    name: row.name,
    project_id: row.project_id,
    hostname: row.hostname,
    os: row.os,
    arch: row.arch,
    machine_user: row.machine_user,
    created_at: new Date(row.created_at).valueOf(),
    connected_at,
    online:
      row.revoked_at == null &&
      connected_at != null &&
      now - connected_at < ONLINE_WITHIN_MS,
    revoked_at:
      row.revoked_at == null ? null : new Date(row.revoked_at).valueOf(),
  };
}

/** The account's computers, revoked ones from the last 30 days included. */
export async function listComputers(
  account_id: string,
): Promise<ComputerSummary[]> {
  requireUuid(account_id, "account_id");
  const { rows } = await getPool().query(
    `SELECT * FROM paired_computers
      WHERE account_id=$1
        AND (revoked_at IS NULL OR revoked_at > now() - interval '30 days')
      ORDER BY revoked_at IS NOT NULL, name`,
    [account_id],
  );
  return rows.map((row) => summary(row));
}

export async function renameComputer({
  account_id,
  computer_id,
  name,
}: {
  account_id: string;
  computer_id: string;
  name: string;
}): Promise<void> {
  requireUuid(account_id, "account_id");
  requireUuid(computer_id, "computer_id");
  const alias = computerName(name);
  await transaction(async (db) => {
    await assertComputersAuthority(db, account_id, "rename a computer");
    const taken = await db.query(
      `SELECT 1 FROM paired_computers
        WHERE account_id=$1 AND name=$2 AND revoked_at IS NULL AND computer_id<>$3`,
      [account_id, alias, computer_id],
    );
    if (taken.rows.length > 0) {
      throw new ComputerRequestError(
        `you already have a computer named @${alias}`,
      );
    }
    const { rows } = await db.query(
      `UPDATE paired_computers SET name=$3
        WHERE account_id=$1 AND computer_id=$2 AND revoked_at IS NULL
        RETURNING computer_id`,
      [account_id, computer_id, alias],
    );
    if (rows.length === 0) throw new ComputerRequestError("no such computer");
  });
}

/**
 * Revoke for good: no more host tokens, and its project's host drops it
 * (within seconds; at most a host token's lifetime if the host can't be
 * told). Its connector then stops every command it runs.
 */
export async function revokeComputer({
  account_id,
  computer_id,
}: {
  account_id: string;
  computer_id: string;
}): Promise<void> {
  requireUuid(account_id, "account_id");
  requireUuid(computer_id, "computer_id");
  const revoked = await transaction(async (db) => {
    await assertComputersAuthority(db, account_id, "revoke a computer");
    return await revokeRows(db, `account_id=$1 AND computer_id=$2`, [
      account_id,
      computer_id,
    ]);
  });
  if (revoked.length === 0) {
    const { rows } = await getPool().query(
      `SELECT 1 FROM paired_computers WHERE account_id=$1 AND computer_id=$2`,
      [account_id, computer_id],
    );
    if (rows.length === 0) throw new ComputerRequestError("no such computer");
    return; // already revoked
  }
  await dropOnHosts(revoked);
}

/**
 * The account is being deleted: revoke all its computers, in the deletion's
 * transaction. The caller tells the hosts afterwards (dropOnHosts).
 */
export async function revokeComputersForAccount(
  db: Queryable,
  account_id: string,
): Promise<{ computer_id: string; project_id: string }[]> {
  return await revokeRows(db, `account_id=$1`, [account_id]);
}

async function revokeRows(
  db: Queryable,
  where: string,
  params: unknown[],
): Promise<{ computer_id: string; project_id: string }[]> {
  const { rows } = await db.query(
    `UPDATE paired_computers SET revoked_at=now()
      WHERE ${where} AND revoked_at IS NULL
      RETURNING computer_id, project_id`,
    params,
  );
  return rows;
}

/** Tell each revoked computer's project host to drop it now (best effort). */
export async function dropOnHosts(
  revoked: { computer_id: string; project_id: string }[],
): Promise<void> {
  for (const { computer_id, project_id } of revoked) {
    try {
      const { rows } = await getPool().query(
        `SELECT host_id FROM projects WHERE project_id=$1`,
        [project_id],
      );
      const host_id = rows[0]?.host_id;
      if (!host_id) continue;
      const host = await getRoutedHostControlClient({
        host_id,
        timeout: 10_000,
      });
      await host.dropComputer({ computer_id });
    } catch (err) {
      // Its host token expires within minutes anyway, and none is issued.
      logger.warn("could not tell a host to drop a revoked computer", {
        computer_id,
        err: `${err}`,
      });
    }
  }
}

/**
 * What a project host needs to know about computers, every 15 s: the site's
 * switch, and the computers of its projects revoked within a host token's
 * lifetime (so a lost dropComputer call is made up within seconds).
 */
export async function computerAccessForHost(
  host_id: string,
): Promise<{ enabled: boolean; revoked: string[] }> {
  // Every one, a page at a time: a lost drop must be made up whatever their
  // number (there are only as many as were revoked within a token's life).
  const revoked: string[] = [];
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const { rows } = await getPool().query(
      `SELECT c.computer_id FROM paired_computers c
         JOIN projects p ON p.project_id = c.project_id
        WHERE p.host_id = $1
          AND c.revoked_at > now() - make_interval(secs => $2)
          AND c.computer_id > $3
        ORDER BY c.computer_id
        LIMIT $4`,
      [host_id, COMPUTER_TOKEN_MAX_TTL_SECONDS + 60, after, ACCESS_PAGE],
    );
    for (const row of rows) revoked.push(row.computer_id);
    if (rows.length < ACCESS_PAGE) break;
    after = rows[rows.length - 1].computer_id;
  }
  return { enabled: await computersEnabled(), revoked };
}

/**
 * A paired computer asks where to connect. Answers its project's host and a
 * short-lived token for it, after checking: its token, not revoked,
 * computers on, the project still has only its owner, and it has a host
 * reachable directly at this bay.
 */
export async function connectComputer({
  computer_id,
  token,
  now = Date.now(),
}: {
  computer_id: unknown;
  token: unknown;
  now?: number;
}): Promise<HostConnection> {
  if (typeof computer_id !== "string" || !isValidUUID(computer_id)) {
    throw new ComputerRequestError("no such computer");
  }
  const { rows } = await getPool().query(
    `SELECT * FROM paired_computers WHERE computer_id=$1`,
    [computer_id],
  );
  const row = rows[0];
  if (
    row == null ||
    typeof token !== "string" ||
    !sameText(row.token_hash, tokenHash(token))
  ) {
    throw new ComputerRequestError("no such computer");
  }
  if (row.revoked_at != null) {
    throw new ComputerRevokedError("this computer was revoked in CoCalc");
  }
  await assertComputersEnabled();
  const { host_id } = await projectForComputers(
    getPool(),
    row.account_id,
    row.project_id,
  );
  if (!host_id) {
    throw new ComputerUnavailableError(
      "its project has no host yet: start the project once",
    );
  }
  const hostBay = await resolveHostBay(host_id);
  if (hostBay != null && hostBay.bay_id !== getConfiguredBayId()) {
    throw new ComputerRequestError(
      "its project runs on another bay's host, which computers don't support yet",
    );
  }
  const connection = await resolveHostConnectionLocal({
    account_id: row.account_id,
    host_id,
    project_id: row.project_id,
  });
  const address = connection?.connect_url?.trim();
  if (!address || connection?.local_proxy) {
    throw new ComputerUnavailableError(
      "its project's host can't be reached directly right now",
    );
  }
  // The host decides from its own copy of the project's collaborators,
  // which collaborator changes keep current. Never pushed from here: an
  // older copy sent now could overwrite a newer one (a collaborator just
  // added) and leave the computer allowed.
  const { token: hostToken, expires_at } = issueProjectHostComputerToken({
    host_id,
    computer_id,
    account_id: row.account_id,
    project_id: row.project_id,
    private_key: getProjectHostAuthTokenPrivateKey(),
    now_ms: now,
  });
  await getPool().query(
    `UPDATE paired_computers SET connected_at=$2 WHERE computer_id=$1`,
    [computer_id, new Date(now)],
  );
  return {
    computer_id,
    project_id: row.project_id,
    host_id,
    address,
    token: hostToken,
    expires_at,
  };
}
