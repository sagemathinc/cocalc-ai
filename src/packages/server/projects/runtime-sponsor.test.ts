import {
  canActorStartUsingRuntimeSponsor,
  getProjectOwnerAccountId,
  resolveRuntimeSponsorAccountId,
} from "./runtime-sponsor";

describe("runtime sponsor resolution", () => {
  it("uses an explicit runtime sponsor before legacy usage attribution", () => {
    expect(
      resolveRuntimeSponsorAccountId({
        runtime_sponsor_account_id: "runtime-sponsor",
        usage_account_id: "usage-account",
        users: {
          "runtime-sponsor": { group: "collaborator" },
          "usage-account": { group: "collaborator" },
          owner: { group: "owner" },
        },
      }),
    ).toBe("runtime-sponsor");
  });

  it("falls back to usage_account_id for existing sponsored projects", () => {
    expect(
      resolveRuntimeSponsorAccountId({
        usage_account_id: "usage-account",
        users: {
          "usage-account": { group: "collaborator" },
          owner: { group: "owner" },
        },
      }),
    ).toBe("usage-account");
  });

  it("ignores an explicit runtime sponsor that is no longer a collaborator", () => {
    expect(
      resolveRuntimeSponsorAccountId({
        runtime_sponsor_account_id: "former-collaborator",
        usage_account_id: "usage-account",
        users: {
          "usage-account": { group: "collaborator" },
          owner: { group: "owner" },
        },
      }),
    ).toBe("usage-account");
  });

  it("ignores usage attribution when that account is not a collaborator", () => {
    expect(
      resolveRuntimeSponsorAccountId({
        usage_account_id: "usage-account",
        users: { owner: { group: "owner" } },
      }),
    ).toBe("owner");
  });

  it("falls back to the project owner", () => {
    expect(
      resolveRuntimeSponsorAccountId({
        users: {
          collaborator: { group: "collaborator" },
          owner: { group: "owner" },
        },
      }),
    ).toBe("owner");
  });

  it("uses the first collaborator when a legacy project has no owner marker", () => {
    expect(
      getProjectOwnerAccountId({
        first: { group: "collaborator" },
        second: { group: "collaborator" },
      }),
    ).toBe("first");
  });

  it("returns undefined when no sponsor can be resolved", () => {
    expect(resolveRuntimeSponsorAccountId({ users: null })).toBeUndefined();
  });

  it("allows collaborators to start using the sponsor by default", () => {
    expect(
      canActorStartUsingRuntimeSponsor({
        project: {
          users: {
            sponsor: { group: "owner" },
            collaborator: { group: "collaborator" },
          },
        },
        sponsor_account_id: "sponsor",
        actor_account_id: "collaborator",
      }),
    ).toBe(true);
  });

  it("blocks ordinary collaborators when sponsor starts are disabled", () => {
    expect(
      canActorStartUsingRuntimeSponsor({
        project: {
          allow_collaborator_starts_using_sponsor: false,
          users: {
            sponsor: { group: "owner" },
            collaborator: { group: "collaborator" },
          },
        },
        sponsor_account_id: "sponsor",
        actor_account_id: "collaborator",
      }),
    ).toBe(false);
  });

  it("still allows the owner, sponsor, and admin when collaborator starts are disabled", () => {
    const project = {
      allow_collaborator_starts_using_sponsor: false,
      users: {
        owner: { group: "owner" },
        sponsor: { group: "collaborator" },
        collaborator: { group: "collaborator" },
      },
    };
    expect(
      canActorStartUsingRuntimeSponsor({
        project,
        sponsor_account_id: "sponsor",
        actor_account_id: "owner",
      }),
    ).toBe(true);
    expect(
      canActorStartUsingRuntimeSponsor({
        project,
        sponsor_account_id: "sponsor",
        actor_account_id: "sponsor",
      }),
    ).toBe(true);
    expect(
      canActorStartUsingRuntimeSponsor({
        project,
        sponsor_account_id: "sponsor",
        actor_account_id: "collaborator",
        is_admin: true,
      }),
    ).toBe(true);
  });
});
