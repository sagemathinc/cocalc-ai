import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import {
  assertApiKeyMembershipGrant,
  assertApiKeyProjectMembership,
  resolveProjectApiKeyRevocation,
} from "./project-membership-revocation";

const watermark = jest.fn();
const owner = jest.fn();
const state = jest.fn();
const reference = jest.fn();
jest.mock("@cocalc/server/conat/project-remote-access", () => ({
  resolveProjectReferenceForMemberAllowRemote: (...args) => reference(...args),
}));
jest.mock("./key-authorization-state", () => ({
  getApiKeyIssuanceWatermark: (...args) => watermark(...args),
  getApiKeyAuthorizationState: (...args) => state(...args),
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (...args) => owner(...args),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-1",
}));

describe("API membership grant cutoff", () => {
  const generation = randomUUID();
  it("denies legacy and old keys but permits a later issuance", () => {
    const barrier = { generation, pending: false, cutoff: "9007199254740993" };
    for (const sequence of ["0", "9007199254740992", "9007199254740993"])
      expect(() => assertApiKeyMembershipGrant(sequence, barrier)).toThrow(
        "membership loss",
      );
    expect(() =>
      assertApiKeyMembershipGrant("9007199254740994", barrier),
    ).not.toThrow();
    expect(() => assertApiKeyMembershipGrant("0", null)).not.toThrow();
  });
  it.each([
    undefined,
    {},
    [],
    { generation, pending: true },
    { generation, pending: false },
    { generation, pending: false, cutoff: 3 },
    { generation: "invalid", pending: false, cutoff: "0" },
  ])("fails closed on pending or malformed state: %j", (barrier) => {
    expect(() => assertApiKeyMembershipGrant("10", barrier)).toThrow();
  });
});

describe("shared project admission", () => {
  const principal = {
    account_id: randomUUID(),
    key_id: "key-12345",
    scope_revision: 1,
  };
  const project = randomUUID();
  beforeEach(() => {
    state
      .mockReset()
      .mockResolvedValue({ scope_revision: 1, issuance_sequence: "3" });
    reference
      .mockReset()
      .mockResolvedValue({
        users: { [principal.account_id]: { group: "collaborator" } },
        api_key_membership_revocation: null,
      });
  });
  it("checks current authority and refuses absent or stale key state", async () => {
    await expect(
      assertApiKeyProjectMembership(principal, project),
    ).resolves.toBeUndefined();
    state
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ scope_revision: 2, issuance_sequence: "3" });
    await expect(
      assertApiKeyProjectMembership(principal, project),
    ).rejects.toThrow("revoked");
    await expect(
      assertApiKeyProjectMembership(principal, project),
    ).rejects.toThrow("scope changed");
  });
  it("does not revive an old key after membership is restored", async () => {
    const users = { [principal.account_id]: { group: "collaborator" } };
    reference.mockResolvedValueOnce({
      users: {},
      api_key_membership_revocation: null,
    });
    await expect(
      assertApiKeyProjectMembership(principal, project),
    ).rejects.toThrow("not a project collaborator");
    reference.mockResolvedValue({
      users,
      api_key_membership_revocation: {
        generation: randomUUID(),
        pending: false,
        cutoff: "3",
      },
    });
    await expect(
      assertApiKeyProjectMembership(principal, project),
    ).rejects.toThrow("membership loss");
    state.mockResolvedValue({ scope_revision: 1, issuance_sequence: "4" });
    await expect(
      assertApiKeyProjectMembership(principal, project),
    ).resolves.toBeUndefined();
    reference.mockResolvedValue({ users });
    await expect(
      assertApiKeyProjectMembership(principal, project),
    ).rejects.toThrow("unavailable");
  });
});

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
describeDb("project owner cutoff installation", () => {
  const pool = getPool();
  const project_id = randomUUID();
  const account_id = randomUUID();
  const other = randomUUID();
  let generation: string;
  beforeAll(async () => {
    await pool.query(`CREATE TABLE projects(project_id uuid PRIMARY KEY,owning_bay_id text,deleted boolean,
      api_key_membership_revocations jsonb,api_key_membership_pending boolean)`);
  });
  beforeEach(async () => {
    generation = randomUUID();
    watermark.mockReset().mockResolvedValue("9007199254740993");
    owner.mockReset().mockResolvedValue({ bay_id: "bay-1", epoch: 1 });
    await pool.query("DELETE FROM projects");
    await pool.query(
      "INSERT INTO projects VALUES($1,'bay-1',false,$2::jsonb,true)",
      [
        project_id,
        JSON.stringify({
          [account_id]: { generation, pending: true },
          [other]: { generation: randomUUID(), pending: true },
        }),
      ],
    );
  });
  const read = async () =>
    (
      await pool.query(
        "SELECT api_key_membership_revocations AS barriers,api_key_membership_pending AS pending FROM projects WHERE project_id=$1",
        [project_id],
      )
    ).rows[0];
  it("installs the exact cutoff and retains other accounts' pending work", async () => {
    expect(
      await resolveProjectApiKeyRevocation({
        project_id,
        account_id,
        generation,
      }),
    ).toBe(true);
    const first = await read();
    expect(first.barriers[account_id]).toEqual({
      generation,
      pending: false,
      cutoff: "9007199254740993",
    });
    expect(first.pending).toBe(true);
    expect(
      await resolveProjectApiKeyRevocation({
        project_id,
        account_id: other,
        generation: first.barriers[other].generation,
      }),
    ).toBe(true);
    expect((await read()).pending).toBe(false);
    expect(
      await resolveProjectApiKeyRevocation({
        project_id,
        account_id,
        generation,
      }),
    ).toBe(false);
  });
  it("cannot clear a newer generation with a delayed reply", async () => {
    const before = await read();
    expect(
      await resolveProjectApiKeyRevocation({
        project_id,
        account_id,
        generation: randomUUID(),
      }),
    ).toBe(false);
    expect(await read()).toEqual(before);
  });
  it("does not lower an existing cutoff", async () => {
    await pool.query(
      "UPDATE projects SET api_key_membership_revocations=jsonb_set(api_key_membership_revocations,ARRAY[$1::text,'cutoff'],to_jsonb('9007199254740995'::text))",
      [account_id],
    );
    await resolveProjectApiKeyRevocation({
      project_id,
      account_id,
      generation,
    });
    expect((await read()).barriers[account_id].cutoff).toBe("9007199254740995");
  });
  it("leaves pending work intact on account-home outage or ownership change", async () => {
    const before = await read();
    watermark.mockRejectedValueOnce(Error("home unavailable"));
    await expect(
      resolveProjectApiKeyRevocation({ project_id, account_id, generation }),
    ).rejects.toThrow("unavailable");
    owner.mockResolvedValueOnce({ bay_id: "bay-2", epoch: 2 });
    await expect(
      resolveProjectApiKeyRevocation({ project_id, account_id, generation }),
    ).rejects.toThrow("owner changed");
    expect(await read()).toEqual(before);
    await pool.query("UPDATE projects SET owning_bay_id='bay-2'");
    expect(
      await resolveProjectApiKeyRevocation({
        project_id,
        account_id,
        generation,
      }),
    ).toBe(false);
    expect(await read()).toEqual(before);
  });
});
