import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { withAccountRehomeWriteFence } from "@cocalc/database/postgres/account-rehome-fence";
import { applyCollaborationAccess } from "@cocalc/database/postgres/collaborators-access";
import {
  entryKey,
  syncCollaboratorsSchema,
} from "@cocalc/database/postgres/collaborators-common";
import {
  collaborationNotificationStore,
  lockCollaborationNotificationAttention,
} from "@cocalc/database/postgres/collaborators-notifications";
import { listCollaborationProjects } from "@cocalc/database/postgres/collaborators-discovery";
import type { CollaborationNotificationDelivery } from "@cocalc/util/collaboration-attention";

beforeAll(async () => {
  await initEphemeralDatabase();
  await syncCollaboratorsSchema();
}, 60000);
afterAll(async () => {
  await getPool().end();
});

async function fixture() {
  const account_id = randomUUID(),
    project_id = randomUUID(),
    generation = randomUUID();
  const grant_request_id = randomUUID(),
    claim_id = randomUUID();
  const resource = {
    project_id,
    kind: "conversation" as const,
    resource_id: "thread",
    thread_id: "thread",
    chat_path: "/home/user/room.chat",
    title: "Discussion",
    activity: 3,
    created_at: 1,
    updated_at: 3,
    participant_ids: [],
  };
  const key = entryKey(resource);
  await getPool().query(
    "INSERT INTO accounts(account_id,home_bay_id) VALUES($1,$2)",
    [account_id, getConfiguredBayId()],
  );
  await getPool().query(
    "INSERT INTO account_project_index(account_id,project_id,title,users_summary) VALUES($1,$2,'Private project',$3::jsonb)",
    [
      account_id,
      project_id,
      JSON.stringify({ [account_id]: { group: "collaborator" } }),
    ],
  );
  await getPool().query(
    `INSERT INTO collaboration_access(account_id,project_id,generation,granted_generation,lease_until,grant_request_id,claim_id)
    VALUES($1,$2,$3,$3,now()+interval '60 seconds',$4,$5)`,
    [account_id, project_id, generation, grant_request_id, claim_id],
  );
  await getPool().query(
    `INSERT INTO collaboration_index(account_id,entry_key,project_id,generation,kind,metadata,participant_ids)
    VALUES($1,$2,$3,$4,'conversation',$5::jsonb,'{}'::uuid[])`,
    [account_id, key, project_id, generation, JSON.stringify(resource)],
  );
  const job = {
    account_id,
    project_id,
    generation,
    cursor: "1",
    claim_id,
    grant_request_id,
  };
  await getPool().query(
    "INSERT INTO collaboration_notification_cursors(account_id,project_id,generation,cursor,claim_id) VALUES($1,$2,$3,'1',$4)",
    [account_id, project_id, generation, claim_id],
  );
  const delivery: CollaborationNotificationDelivery = {
    account_id,
    access_generation: generation,
    grant_request_id,
    event: {
      version: 1,
      project_id,
      room_id: randomUUID(),
      thread_id: "thread",
      message_id: "message",
      actor_account_id: randomUUID(),
      activity: 2,
      mode: "live",
      mentioned_account_ids: [account_id],
      mention_all: false,
    },
  };
  return {
    account_id,
    project_id,
    generation,
    grant_request_id,
    job,
    delivery,
    resource,
  };
}

test.each(["expired lease", "newer grant"])(
  "notification delivery retries after %s instead of using stale authority",
  async (mode) => {
    const f = await fixture();
    if (mode === "expired lease")
      await getPool().query(
        "UPDATE collaboration_access SET lease_until=now()-interval '1 second' WHERE account_id=$1",
        [f.account_id],
      );
    else
      await getPool().query(
        "UPDATE collaboration_access SET granted_generation=$2 WHERE account_id=$1",
        [f.account_id, randomUUID()],
      );
    await expect(
      withAccountRehomeWriteFence({
        account_id: f.account_id,
        action: "test notification fence",
        fn: (db) =>
          lockCollaborationNotificationAttention({ db, delivery: f.delivery }),
      }),
    ).rejects.toThrow(/not ready|lease|generation/i);
  },
);

test("observed notification denial fences an earlier in-flight grant and discovery revision", async () => {
  const f = await fixture();
  const requested_at = Date.now();
  const before = (
    await getPool().query(
      "SELECT revision FROM collaboration_account_state WHERE account_id=$1",
      [f.account_id],
    )
  ).rows[0].revision;
  const store = collaborationNotificationStore(
    async () => ({ allowed: false }),
    getConfiguredBayId(),
  );
  expect(await store.acknowledge(f.job, { allowed: false })).toBe(true);
  expect(
    await applyCollaborationAccess(
      [
        {
          account_id: f.account_id,
          project_id: f.project_id,
          grant_request_id: f.grant_request_id,
        },
      ],
      [
        {
          account_id: f.account_id,
          project_id: f.project_id,
          generation: f.generation,
        },
      ],
      requested_at,
    ),
  ).toBe(0);
  expect(
    (await listCollaborationProjects({ account_id: f.account_id })).items,
  ).toEqual([]);
  expect(
    Number(
      (
        await getPool().query(
          "SELECT revision FROM collaboration_account_state WHERE account_id=$1",
          [f.account_id],
        )
      ).rows[0].revision,
    ),
  ).toBeGreaterThan(Number(before));
});

test("notification denial preserves existing Library identity bindings before dropping projections", async () => {
  const f = await fixture();
  const artifact = {
    ...f.resource,
    kind: "artifact" as const,
    resource_id: "artifact",
    artifact_id: "artifact",
    entry_id: "old-native-entry",
  };
  await getPool().query(
    `INSERT INTO collaboration_index(account_id,entry_key,project_id,generation,kind,metadata)
    VALUES($1,$2,$3,$4,'artifact',$5::jsonb)`,
    [
      f.account_id,
      entryKey(artifact),
      f.project_id,
      f.generation,
      JSON.stringify(artifact),
    ],
  );
  await getPool().query(
    "INSERT INTO personal_library_aliases(account_id,name,project_id,entry_id,active) VALUES($1,'kept-name',$2,$3,true)",
    [f.account_id, f.project_id, artifact.entry_id],
  );
  const store = collaborationNotificationStore(
    async () => ({ allowed: false }),
    getConfiguredBayId(),
  );
  expect(await store.acknowledge(f.job, { allowed: false })).toBe(true);
  expect(
    (
      await getPool().query(
        "SELECT entry_id FROM collaboration_artifact_bindings WHERE account_id=$1 AND entry_key=$2",
        [f.account_id, entryKey(artifact)],
      )
    ).rows,
  ).toEqual([{ entry_id: artifact.entry_id }]);
});
