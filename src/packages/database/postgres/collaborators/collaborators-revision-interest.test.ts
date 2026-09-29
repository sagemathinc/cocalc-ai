import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  registerCollaborationRevisionInterest,
  releaseCollaborationRevisionInterest,
  readCollaborationRevisionHint,
  acknowledgeCollaborationRevisionHint,
  syncCollaborationRevisionInterestSchema,
} from "./collaborators-revision-interest";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" &&
  process.env.COCALC_DB === "pglite" &&
  process.env.COCALC_PGLITE_DATA_DIR === "memory://"
    ? describe
    : describe.skip;
describeDb("owner project/home revision interests", () => {
  const authority = { owning_bay_id: "interest-owner" };
  beforeAll(async () => {
    await initEphemeralDatabase();
    await syncCollaborationRevisionInterestSchema(getPool());
  }, 60000);
  afterAll(async () => {
    await getPool().end();
  });
  async function fixture() {
    const account_id = randomUUID(),
      peer = randomUUID(),
      project_id = randomUUID();
    await getPool().query(
      "INSERT INTO projects(project_id,owning_bay_id,users) VALUES($1,$2,$3)",
      [
        project_id,
        authority.owning_bay_id,
        JSON.stringify({
          [account_id]: { group: "collaborator" },
          [peer]: { group: "collaborator" },
        }),
      ],
    );
    return { request: { project_id, account_id, home_bay_id: "home-a" }, peer };
  }
  test("renewal fences delayed release and current release works after revocation", async () => {
    const { request } = await fixture();
    const first = await registerCollaborationRevisionInterest(
      request,
      authority,
    );
    const release = (lease_id: string, home_bay_id = request.home_bay_id) =>
      releaseCollaborationRevisionInterest(
        { project_id: request.project_id, home_bay_id, lease_id },
        authority,
      );
    await getPool().query(
      "UPDATE collaboration_revision_interests SET renew_after=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [request.project_id],
    );
    const renewed = await registerCollaborationRevisionInterest(
      request,
      authority,
    );
    expect(renewed.lease_id).not.toBe(first.lease_id);
    expect(await release(first.lease_id)).toBe(false);
    expect(await release(renewed.lease_id, "another-home")).toBe(false);
    expect(
      await registerCollaborationRevisionInterest(request, authority),
    ).toEqual(renewed);
    await expect(
      releaseCollaborationRevisionInterest(
        { ...request, lease_id: renewed.lease_id },
        { owning_bay_id: "wrong" },
      ),
    ).rejects.toThrow();
    await getPool().query(
      "UPDATE projects SET users='{}'::jsonb WHERE project_id=$1",
      [request.project_id],
    );
    expect(await release(renewed.lease_id)).toBe(true);
    expect(await release(renewed.lease_id)).toBe(false);
  });
  test("coalesced hints retain newer revisions and fence generation and lease changes", async () => {
    const { request } = await fixture();
    const lease = await registerCollaborationRevisionInterest(
      request,
      authority,
    );
    const lookup = { ...request, lease_id: lease.lease_id };
    const generation = randomUUID();
    await getPool().query(
      "INSERT INTO collaboration_projects(project_id,generation,revision) VALUES($1,$2,7)",
      [request.project_id, generation],
    );
    expect(await readCollaborationRevisionHint(lookup, authority)).toEqual({
      generation,
      revision: 7,
    });
    await getPool().query(
      "UPDATE collaboration_projects SET revision=9 WHERE project_id=$1",
      [request.project_id],
    );
    const ack = (revision: number, gen = generation) =>
      acknowledgeCollaborationRevisionHint(
        { ...lookup, generation: gen, revision },
        authority,
      );
    expect(await ack(7)).toBe(true);
    expect(await readCollaborationRevisionHint(lookup, authority)).toEqual({
      generation,
      revision: 9,
    });
    expect(await ack(10)).toBe(false);
    expect(await ack(9, randomUUID())).toBe(false);
    expect(await ack(9)).toBe(true);
    expect(await ack(7)).toBe(true);
    expect(await readCollaborationRevisionHint(lookup, authority)).toBeNull();
    await getPool().query(
      "UPDATE collaboration_revision_interests SET renew_after=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [request.project_id],
    );
    const renewed = await registerCollaborationRevisionInterest(
      request,
      authority,
    );
    expect(await ack(9)).toBe(false);
    expect(
      await readCollaborationRevisionHint(
        { ...lookup, lease_id: renewed.lease_id },
        authority,
      ),
    ).toBeNull();
    const nextGeneration = randomUUID();
    await getPool().query(
      "UPDATE collaboration_projects SET generation=$2 WHERE project_id=$1",
      [request.project_id, nextGeneration],
    );
    expect(
      await readCollaborationRevisionHint(
        { ...lookup, lease_id: renewed.lease_id },
        authority,
      ),
    ).toEqual({ generation: nextGeneration, revision: 9 });
    await getPool().query(
      "UPDATE collaboration_revision_interests SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [request.project_id],
    );
    expect(
      await readCollaborationRevisionHint(
        { ...lookup, lease_id: renewed.lease_id },
        authority,
      ),
    ).toBeNull();
  });
  test("same-home consumers share a lease without retry extension", async () => {
    const { request, peer } = await fixture();
    const first = await registerCollaborationRevisionInterest(
      request,
      authority,
    );
    expect(first.watermark).toBeNull();
    expect(
      await registerCollaborationRevisionInterest(
        { ...request, account_id: peer },
        authority,
      ),
    ).toEqual(first);
    const other = await registerCollaborationRevisionInterest(
      { ...request, home_bay_id: "home-b" },
      authority,
    );
    expect(other.lease_id).not.toBe(first.lease_id);
    expect(
      (
        await getPool().query(
          "SELECT count(*)::integer AS n FROM collaboration_revision_interests WHERE project_id=$1",
          [request.project_id],
        )
      ).rows[0].n,
    ).toBe(2);
    expect(
      (
        await getPool().query(
          "SELECT * FROM collaboration_projects WHERE project_id=$1",
          [request.project_id],
        )
      ).rows,
    ).toEqual([]);
  });
  test("expired interest gets a new lease and samples the current catalog", async () => {
    const { request } = await fixture();
    const first = await registerCollaborationRevisionInterest(
      request,
      authority,
    );
    const generation = randomUUID();
    await getPool().query(
      "INSERT INTO collaboration_projects(project_id,generation,revision) VALUES($1,$2,7)",
      [request.project_id, generation],
    );
    await getPool().query(
      "UPDATE collaboration_revision_interests SET expires_at=clock_timestamp()-interval '1 second',renew_after=clock_timestamp()-interval '1 minute' WHERE project_id=$1",
      [request.project_id],
    );
    const next = await registerCollaborationRevisionInterest(
      request,
      authority,
    );
    expect(next.lease_id).not.toBe(first.lease_id);
    expect(next.watermark).toEqual({ generation, revision: 7 });
  });
  test("current membership and owner are checked even for an unrenewable retry", async () => {
    const { request } = await fixture();
    await registerCollaborationRevisionInterest(request, authority);
    await expect(
      registerCollaborationRevisionInterest(request, {
        owning_bay_id: "wrong",
      }),
    ).rejects.toThrow();
    await getPool().query(
      "UPDATE projects SET users='{}'::jsonb WHERE project_id=$1",
      [request.project_id],
    );
    await expect(
      registerCollaborationRevisionInterest(request, authority),
    ).rejects.toThrow("access denied");
  });
});
