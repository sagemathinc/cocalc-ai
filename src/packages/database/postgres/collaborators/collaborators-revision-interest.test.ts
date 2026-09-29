import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  registerCollaborationRevisionInterest,
  releaseCollaborationRevisionInterest,
  readCollaborationRevisionHint,
  acknowledgeCollaborationRevisionHint,
  syncCollaborationRevisionInterestSchema,
  readCollaborationRevisionFanoutPage,
  claimCollaborationRevisionHint,
  settleCollaborationRevisionHint,
  pruneCollaborationRevisionInterests,
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
    return {
      request: {
        project_id,
        account_id,
        home_bay_id: "home-a",
        ttl_ms: 120000,
      },
      peer,
    };
  }
  test("owner expiry cleanup is bounded and preserves renewed interests", async () => {
    const { request } = await fixture();
    const initial = await registerCollaborationRevisionInterest(
      request,
      authority,
    );
    await getPool().query(
      `UPDATE collaboration_revision_interests SET expires_at=clock_timestamp()-interval '1 second'
       WHERE project_id=$1`,
      [request.project_id],
    );
    const renewed = await registerCollaborationRevisionInterest(
      request,
      authority,
    );
    expect(renewed.lease_id).not.toBe(initial.lease_id);
    await getPool().query(
      `INSERT INTO collaboration_revision_interests(project_id,home_bay_id,lease_id,expires_at,renew_after)
       SELECT $1,'expired-' || n,gen_random_uuid(),clock_timestamp()-interval '1 second',clock_timestamp()
       FROM generate_series(1,105) AS n`,
      [request.project_id],
    );
    await expect(
      pruneCollaborationRevisionInterests(request.project_id, {
        owning_bay_id: "wrong",
      }),
    ).rejects.toThrow("owner");
    expect(
      await pruneCollaborationRevisionInterests(request.project_id, authority),
    ).toBe(100);
    expect(
      await pruneCollaborationRevisionInterests(request.project_id, authority),
    ).toBe(5);
    expect(
      await pruneCollaborationRevisionInterests(request.project_id, authority),
    ).toBe(0);
    const { rows } = await getPool().query(
      "SELECT lease_id FROM collaboration_revision_interests WHERE project_id=$1",
      [request.project_id],
    );
    expect(rows).toEqual([{ lease_id: renewed.lease_id }]);
    // Expiry cleanup is independent of remaining human membership.
    await getPool().query(
      "UPDATE projects SET users='{}' WHERE project_id=$1",
      [request.project_id],
    );
    await getPool().query(
      "UPDATE collaboration_revision_interests SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [request.project_id],
    );
    expect(
      await pruneCollaborationRevisionInterests(request.project_id, authority),
    ).toBe(1);
  });
  test("delivery claims survive unknown outcomes and fence stale settlements", async () => {
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
    const first = await claimCollaborationRevisionHint(lookup, authority);
    expect(first).not.toBeNull();
    expect(first!.claim_until).toBeLessThanOrEqual(lease.expires_at);
    expect(await claimCollaborationRevisionHint(lookup, authority)).toBeNull();
    await getPool().query(
      "UPDATE collaboration_projects SET revision=9 WHERE project_id=$1",
      [request.project_id],
    );
    expect(
      await settleCollaborationRevisionHint(
        { ...first!, revision: 9 },
        authority,
      ),
    ).toBe(false);
    expect(await settleCollaborationRevisionHint(first!, authority)).toBe(true);
    expect(await settleCollaborationRevisionHint(first!, authority)).toBe(
      false,
    );
    const second = await claimCollaborationRevisionHint(lookup, authority);
    expect(second!.revision).toBe(9);
    // A transport timeout is not a failed delivery. No settlement occurs; a
    // later worker can reclaim only after the durable deadline.
    await getPool().query(
      "UPDATE collaboration_revision_interests SET delivery_until=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [request.project_id],
    );
    const retry = await claimCollaborationRevisionHint(lookup, authority);
    expect(retry!.claim_id).not.toBe(second!.claim_id);
    expect(await settleCollaborationRevisionHint(second!, authority)).toBe(
      false,
    );
    expect(await settleCollaborationRevisionHint(retry!, authority)).toBe(true);
    expect(await claimCollaborationRevisionHint(lookup, authority)).toBeNull();
    await getPool().query(
      "UPDATE collaboration_projects SET revision=10 WHERE project_id=$1",
      [request.project_id],
    );
    const pending = await claimCollaborationRevisionHint(lookup, authority);
    await getPool().query(
      "UPDATE collaboration_revision_interests SET renew_after=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [request.project_id],
    );
    const renewed = await registerCollaborationRevisionInterest(
      request,
      authority,
    );
    expect(await settleCollaborationRevisionHint(pending!, authority)).toBe(
      false,
    );
    expect(await claimCollaborationRevisionHint(lookup, authority)).toBeNull();
    const current = await claimCollaborationRevisionHint(
      { ...lookup, lease_id: renewed.lease_id },
      authority,
    );
    expect(current!.revision).toBe(10);
    await getPool().query(
      "UPDATE collaboration_projects SET generation=$2 WHERE project_id=$1",
      [request.project_id, randomUUID()],
    );
    expect(await settleCollaborationRevisionHint(current!, authority)).toBe(
      false,
    );
  });
  test("fanout bounds examined rows even when the first page is entirely idle", async () => {
    const { request } = await fixture();
    const generation = randomUUID();
    await getPool().query(
      "INSERT INTO collaboration_projects(project_id,generation,revision) VALUES($1,$2,9)",
      [request.project_id, generation],
    );
    await getPool().query(
      `INSERT INTO collaboration_revision_interests(project_id,home_bay_id,lease_id,expires_at,renew_after,ack_generation,ack_revision)
       SELECT $1,'home-'||lpad(n::text,3,'0'),$2,clock_timestamp()+interval '60 seconds',clock_timestamp(),$3,
       CASE WHEN n<20 THEN 9 ELSE 7 END FROM generate_series(0,24) AS n`,
      [request.project_id, randomUUID(), generation],
    );
    const first = await readCollaborationRevisionFanoutPage(
      { project_id: request.project_id },
      authority,
    );
    expect(first).toEqual({ examined: 20, next_after: "home-019", hints: [] });
    const second = await readCollaborationRevisionFanoutPage(
      { project_id: request.project_id, after_home_bay_id: first.next_after! },
      authority,
    );
    expect(second.examined).toBe(5);
    expect(second.next_after).toBeNull();
    expect(second.hints.map((x) => x.home_bay_id)).toEqual([
      "home-020",
      "home-021",
      "home-022",
      "home-023",
      "home-024",
    ]);
    expect(
      second.hints.every(
        (x) => x.generation === generation && x.revision === 9,
      ),
    ).toBe(true);
    expect(
      await readCollaborationRevisionFanoutPage(
        {
          project_id: request.project_id,
          after_home_bay_id: first.next_after!,
        },
        authority,
      ),
    ).toEqual(second);
    const nextGeneration = randomUUID();
    await getPool().query(
      "UPDATE collaboration_projects SET generation=$2,revision=1 WHERE project_id=$1",
      [request.project_id, nextGeneration],
    );
    const restarted = await readCollaborationRevisionFanoutPage(
      { project_id: request.project_id },
      authority,
    );
    expect(restarted.hints).toHaveLength(20);
    expect(
      restarted.hints.every(
        (x) => x.generation === nextGeneration && x.revision === 1,
      ),
    ).toBe(true);
    await getPool().query(
      "UPDATE collaboration_revision_interests SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [request.project_id],
    );
    expect(
      (
        await readCollaborationRevisionFanoutPage(
          { project_id: request.project_id },
          authority,
        )
      ).hints,
    ).toEqual([]);
    await expect(
      readCollaborationRevisionFanoutPage(
        { project_id: request.project_id },
        { owning_bay_id: "wrong" },
      ),
    ).rejects.toThrow();
  });
  test("short demand bounds new interests without shortening another consumer's lease", async () => {
    const { request } = await fixture();
    const before = Date.now();
    const short = await registerCollaborationRevisionInterest(
      { ...request, ttl_ms: 5000 },
      authority,
    );
    expect(short.expires_at).toBeLessThanOrEqual(Date.now() + 5000);
    expect(short.expires_at).toBeGreaterThan(before);
    await getPool().query(
      "UPDATE collaboration_revision_interests SET renew_after=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [request.project_id],
    );
    const shorter = await registerCollaborationRevisionInterest(
      { ...request, ttl_ms: 1000 },
      authority,
    );
    expect(shorter.expires_at).toBe(short.expires_at);
    await expect(
      registerCollaborationRevisionInterest(
        { ...request, ttl_ms: 0 },
        authority,
      ),
    ).rejects.toThrow("no home demand");
  });
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
    ).toEqual({ ...renewed, remaining_ms: expect.any(Number) });
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
    ).toEqual({ ...first, remaining_ms: expect.any(Number) });
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
