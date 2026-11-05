import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import {
  applyArtifactCatalogSnapshot,
  registerArtifactCatalogSource,
} from "./artifact-catalog";
import {
  ARTIFACT_CATALOG_NOT_PERMITTED,
  authorizedArtifactCatalogProjects,
  readArtifactCatalogEntriesForAccountLocal as getEntries,
} from "./artifact-catalog-read";

const bay = "bay-test";
const host_id = randomUUID();
const owner = randomUUID();
const collaborator = randomUUID();
const viewer = randomUUID();
const stranger = randomUUID();

async function project(
  users: Record<string, string>,
  opts: { owning_bay_id?: string | null; deleted?: boolean } = {},
): Promise<string> {
  const project_id = randomUUID();
  await getPool().query(
    `INSERT INTO projects(project_id,host_id,owning_bay_id,users,deleted)
     VALUES($1,$2,$3,$4::jsonb,$5)`,
    [
      project_id,
      host_id,
      opts.owning_bay_id === undefined ? bay : opts.owning_bay_id,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(users).map(([id, group]) => [id, { group }]),
        ),
      ),
      opts.deleted ?? false,
    ],
  );
  return project_id;
}

async function publish(project_id: string, ids: string[]): Promise<string[]> {
  const source = { project_id, chat_path: "/home/user/work.chat" };
  const authority = { owning_bay_id: bay, host_id };
  const epoch = await registerArtifactCatalogSource(
    source,
    authority,
    null,
    randomUUID(),
  );
  await applyArtifactCatalogSnapshot(
    {
      ...source,
      schema_version: 1,
      epoch,
      sequence: 1,
      items: ids.map((artifact_id, i) => ({
        thread_id: "thread",
        artifact_id,
        kind: "file",
        title: artifact_id,
        description: "",
        created_at: 1000 + i,
        publication: { operation_id: "op", message_id: "msg" },
      })),
    },
    authority,
  );
  const { rows } = await getPool().query(
    "SELECT entry_id FROM artifact_catalog WHERE project_id=$1 ORDER BY created_at",
    [project_id],
  );
  return rows.map((row) => row.entry_id);
}

beforeAll(async () => {
  await initEphemeralDatabase({});
}, 30000);
afterAll(async () => {
  await testCleanup();
});

describe("account-scoped catalog authorization", () => {
  test("owners and collaborators of live projects on this bay, never viewers", async () => {
    const live = await project({
      [owner]: "owner",
      [collaborator]: "collaborator",
      [viewer]: "viewer",
    });
    const noBay = await project({ [owner]: "owner" }, { owning_bay_id: null });
    const foreign = await project(
      { [owner]: "owner" },
      { owning_bay_id: "other-bay" },
    );
    const deleted = await project({ [owner]: "owner" }, { deleted: true });
    const all = [live, noBay, foreign, deleted, randomUUID()];
    const read = async (account_id: string) =>
      await authorizedArtifactCatalogProjects(getPool(), {
        account_id,
        owning_bay_id: bay,
        project_ids: all,
      });
    expect(await read(owner)).toEqual(new Set([live, noBay]));
    expect(await read(collaborator)).toEqual(new Set([live]));
    expect(await read(viewer)).toEqual(new Set());
    expect(await read(stranger)).toEqual(new Set());
  });
});

describe("getEntries", () => {
  let mine: string;
  let theirs: string;
  let mineIds: string[];
  let theirIds: string[];
  beforeAll(async () => {
    mine = await project({ [owner]: "owner", [viewer]: "viewer" });
    theirs = await project({ [stranger]: "owner" });
    mineIds = await publish(mine, ["a", "b"]);
    theirIds = await publish(theirs, ["x"]);
  });

  test("returns readable entries, omits absent ones and de-duplicates", async () => {
    const result = await getEntries({
      account_id: owner,
      owning_bay_id: bay,
      items: [
        { project_id: mine, entry_id: mineIds[1] },
        { project_id: mine, entry_id: mineIds[0] },
        { project_id: mine, entry_id: mineIds[0] },
        { project_id: mine, entry_id: "0".repeat(64) },
      ],
    });
    expect(result.map((e) => e.item.artifact_id).sort()).toEqual(["a", "b"]);
    expect(result[0]).toMatchObject({
      project_id: mine,
      chat_path: "/home/user/work.chat",
    });
  });

  test("any unreadable project fails the whole request with one uniform error", async () => {
    // A readable entry alongside one from a project the caller cannot read.
    await expect(
      getEntries({
        account_id: owner,
        owning_bay_id: bay,
        items: [
          { project_id: mine, entry_id: mineIds[0] },
          { project_id: theirs, entry_id: theirIds[0] },
        ],
      }),
    ).rejects.toThrow(ARTIFACT_CATALOG_NOT_PERMITTED);
    // Viewers, unknown projects and foreign bays get the same error.
    for (const [account_id, project_id, owning_bay_id] of [
      [viewer, mine, bay],
      [owner, randomUUID(), bay],
      [owner, mine, "other-bay"],
    ])
      await expect(
        getEntries({
          account_id,
          owning_bay_id,
          items: [{ project_id, entry_id: mineIds[0] }],
        }),
      ).rejects.toThrow(ARTIFACT_CATALOG_NOT_PERMITTED);
  });

  test("validates the request before any lookup", async () => {
    const good = { project_id: mine, entry_id: mineIds[0] };
    for (const items of [
      [],
      undefined,
      "x",
      Array.from({ length: 101 }, () => good),
      [{ project_id: "not-a-uuid", entry_id: mineIds[0] }],
      [{ project_id: mine, entry_id: "A".repeat(64) }],
      // '' is the change log's reset sentinel, never a catalog entry.
      [{ project_id: mine, entry_id: "" }],
      [{ project_id: mine }],
    ])
      await expect(
        getEntries({ account_id: owner, owning_bay_id: bay, items }),
      ).rejects.toThrow("invalid catalog entry list");
  });
});
