import { randomUUID } from "node:crypto";
import "@cocalc/util/db-schema/collaborators-workspace";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { syncCollaboratorsSchema } from "./collaborators-common";
import { requestCollaborationSource } from "./collaborators-adoption";
import { collaborationSourcePage } from "./collaborators-owner";

const project_id = randomUUID();
const account_id = randomUUID();
const viewer_id = randomUUID();
const host_id = randomUUID();
const authority = { owning_bay_id: "adoption-test", host_id };
const request = {
  project_id,
  account_id,
  chat_path: "/home/user/history.chat",
};

beforeAll(async () => {
  await initEphemeralDatabase({});
  await syncCollaboratorsSchema();
  await getPool().query(
    "INSERT INTO projects(project_id,owning_bay_id,host_id,users) VALUES($1,$2,$3,$4::jsonb)",
    [
      project_id,
      authority.owning_bay_id,
      host_id,
      JSON.stringify({
        [account_id]: { group: "collaborator" },
        [viewer_id]: { group: "viewer" },
      }),
    ],
  );
}, 30000);
beforeEach(async () => {
  await getPool().query(
    "DELETE FROM collaboration_source_requests WHERE project_id=$1",
    [project_id],
  );
});
afterAll(async () => {
  await testCleanup();
});

test("explicit legacy request is idempotent metadata, discoverable without starting a host", async () => {
  expect(await requestCollaborationSource(request, authority)).toEqual({
    requested: true,
  });
  expect(await requestCollaborationSource(request, authority)).toEqual({
    requested: true,
  });
  expect(
    (await collaborationSourcePage(project_id, authority)).paths,
  ).toContain(request.chat_path);
  expect(
    (
      await getPool().query(
        "SELECT count(*) AS n FROM collaboration_source_requests WHERE project_id=$1",
        [project_id],
      )
    ).rows[0].n,
  ).toBe("1");
  expect(
    (
      await getPool().query(
        "SELECT 1 FROM collaboration_sources WHERE project_id=$1",
        [project_id],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await getPool().query(
        "SELECT 1 FROM collaboration_rooms WHERE project_id=$1",
        [project_id],
      )
    ).rows,
  ).toEqual([]);
});

test("file viewers, stale owners and noncanonical paths cannot request indexing", async () => {
  await expect(
    requestCollaborationSource(
      { ...request, account_id: viewer_id },
      authority,
    ),
  ).rejects.toThrow("access denied");
  await expect(
    requestCollaborationSource(request, { owning_bay_id: "wrong" }),
  ).rejects.toThrow("unavailable");
  await expect(
    requestCollaborationSource(
      { ...request, chat_path: "/home/user/../history.chat" },
      authority,
    ),
  ).rejects.toThrow("canonical");
});

test("pending-source quota bounds opt-in inventory while allowing retries", async () => {
  await requestCollaborationSource(request, authority);
  await getPool().query(
    `INSERT INTO collaboration_source_requests(project_id,chat_path,requested_by)
     SELECT $1,'/home/user/history-' || n || '.chat',$2 FROM generate_series(1,1023) n`,
    [project_id, account_id],
  );
  await expect(requestCollaborationSource(request, authority)).resolves.toEqual(
    { requested: true },
  );
  await expect(
    requestCollaborationSource(
      { ...request, chat_path: "/home/user/overflow.chat" },
      authority,
    ),
  ).rejects.toThrow("capacity");
});
