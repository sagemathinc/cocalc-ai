/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { assertProjectNotRehoming } from "@cocalc/database/postgres/project-rehome-fence";
import { getConfiguredBayId } from "@cocalc/server/bay-config";

export async function upsertProjectSshKeyInDb({
  project_id,
  account_id,
  fingerprint,
  payload,
}: {
  project_id: string;
  account_id: string;
  fingerprint: string;
  payload: {
    title: string;
    value: string;
    creation_date: number;
    last_use_date?: number;
  };
}): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await assertProjectNotRehoming({
      db: client,
      project_id,
      action: "set project ssh key",
    });
    const result = await client.query(
      `UPDATE projects
          SET users = jsonb_set(
            COALESCE(users, '{}'::jsonb),
            ARRAY[$2::text, 'ssh_keys'],
            COALESCE(users #> ARRAY[$2::text, 'ssh_keys'], '{}'::jsonb) ||
              jsonb_build_object($3::text, $4::jsonb),
            true
          )
        WHERE project_id = $1
          AND COALESCE(owning_bay_id, $5) = $5
          AND (users -> $2::text ->> 'group') IN ('owner', 'collaborator')`,
      [
        project_id,
        account_id,
        fingerprint,
        JSON.stringify(payload),
        getConfiguredBayId(),
      ],
    );
    await client.query("COMMIT");
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteProjectSshKeyInDb({
  project_id,
  account_id,
  fingerprint,
}: {
  project_id: string;
  account_id: string;
  fingerprint: string;
}): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await assertProjectNotRehoming({
      db: client,
      project_id,
      action: "delete project ssh key",
    });
    const result = await client.query(
      `UPDATE projects
          SET users = CASE
            WHEN COALESCE(users #> ARRAY[$2::text, 'ssh_keys'], '{}'::jsonb) - $3::text = '{}'::jsonb
              THEN users #- ARRAY[$2::text, 'ssh_keys']
            ELSE jsonb_set(
              COALESCE(users, '{}'::jsonb),
              ARRAY[$2::text, 'ssh_keys'],
              COALESCE(users #> ARRAY[$2::text, 'ssh_keys'], '{}'::jsonb) - $3::text,
              true
            )
          END
        WHERE project_id = $1
          AND COALESCE(owning_bay_id, $4) = $4
          AND (users -> $2::text ->> 'group') IN ('owner', 'collaborator')`,
      [project_id, account_id, fingerprint, getConfiguredBayId()],
    );
    await client.query("COMMIT");
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
