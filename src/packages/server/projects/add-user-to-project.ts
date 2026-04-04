import getPool from "@cocalc/database/pool";
import { jsonbSet } from "@cocalc/database/postgres/jsonb-utils";
import { appendProjectOutboxEventForProject } from "@cocalc/database/postgres/project-events-outbox";
import { isValidUUID } from "@cocalc/util/misc";
import { syncProjectUsersOnHost } from "@cocalc/server/project-host/control";

interface Options {
  account_id: string;
  project_id: string;
  group?: string;
}

export default async function addUserToProject({
  account_id,
  project_id,
  group, // default is 'collaborator'
}: Options): Promise<void> {
  if (!isValidUUID(account_id) || !isValidUUID(project_id)) {
    throw Error("account_id and project_id must be UUID's");
  }
  const pool = getPool();
  if (!group) {
    group = "collaborator";
  }
  const { set, params } = jsonbSet({ users: { [account_id]: { group } } });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE projects SET ${set} WHERE project_id=$${params.length + 1}`,
      params.concat(project_id),
    );
    await appendProjectOutboxEventForProject({
      db: client,
      event_type: "project.membership_changed",
      project_id,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  await syncProjectUsersOnHost({ project_id });
}
