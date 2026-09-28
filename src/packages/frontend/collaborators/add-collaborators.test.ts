import {
  selectedCollaboratorUsersForEntries,
  uniqueSelectedCollaboratorEntries,
  inviteToProjects,
} from "./add-collaborators";

describe("collaborator invite selection", () => {
  it("deduplicates selected invite entries without reordering them", () => {
    expect(
      uniqueSelectedCollaboratorEntries([
        "account-1",
        "",
        "account-2",
        "account-1",
      ]),
    ).toEqual(["account-1", "account-2"]);
  });

  it("preserves selected user metadata across later searches", () => {
    const alice = {
      account_id: "account-alice",
      first_name: "Alice",
      last_name: "A",
    };
    const bob = {
      account_id: "account-bob",
      first_name: "Bob",
      last_name: "B",
    };

    expect(
      selectedCollaboratorUsersForEntries(
        ["account-alice", "account-bob"],
        [alice],
        [bob],
      ),
    ).toEqual([alice, bob]);
  });

  it("drops metadata for entries the user removed from the multi-select", () => {
    const alice = {
      account_id: "account-alice",
      first_name: "Alice",
      last_name: "A",
    };
    const bob = {
      account_id: "account-bob",
      first_name: "Bob",
      last_name: "B",
    };

    expect(
      selectedCollaboratorUsersForEntries(["account-bob"], [alice, bob], []),
    ).toEqual([bob]);
  });
});

describe("multi-project invitation attempts", () => {
  it("deduplicates targets, reports partial failures, and never retries", async () => {
    const invite = jest.fn(async (id) => {
      if (id === "failed") throw Error("No slots remain");
      if (id === "unconfirmed") return undefined;
      return { email_sent: true } as any;
    });
    const outcomes: any[] = [];
    await inviteToProjects({
      projectIds: ["ok", "failed", "ok", "unconfirmed", "last"],
      check: async () => undefined,
      title: (id) => id,
      invite,
      onResult: (result) => outcomes.push(result),
    });
    expect(invite.mock.calls.map(([id]) => id)).toEqual([
      "ok",
      "failed",
      "unconfirmed",
      "last",
    ]);
    expect(outcomes.map(({ status }) => status)).toEqual([
      "success",
      "failed",
      "failed",
      "success",
    ]);
    expect(outcomes[2].message).toContain("not confirmed");
  });

  it("does not invite existing members or projects that fail permission checks", async () => {
    const invite = jest.fn();
    const onResult = jest.fn();
    await inviteToProjects({
      projectIds: ["member", "viewer"],
      check: async (id) => {
        if (id === "member") return "Already a project member";
        throw Error("Full collaborator access is required");
      },
      title: (id) => id,
      invite,
      onResult,
    });
    expect(invite).not.toHaveBeenCalled();
    expect(onResult.mock.calls.map(([result]) => result.status)).toEqual([
      "skipped",
      "failed",
    ]);
  });

  it("preserves manual links even when another project fails", async () => {
    const outcomes: any[] = [];
    await inviteToProjects({
      projectIds: ["manual", "failure"],
      check: async () => undefined,
      title: (id) => id,
      invite: async (id) => {
        if (id === "failure") throw Error("Network failure");
        return {
          manual_delivery_required: true,
          invites: [{ invite_url: "https://example.test/invite" }],
        } as any;
      },
      onResult: (result) => outcomes.push(result),
    });
    expect(outcomes[0].invite_urls).toEqual(["https://example.test/invite"]);
    expect(outcomes[0].message).toContain("send them manually");
    expect(outcomes[1].status).toBe("failed");
  });
});
