import {
  addCollaboratorQueryResults,
  emptyCollaboratorSearchResults,
  selectedCollaboratorUsersForEntries,
  uniqueSelectedCollaboratorEntries,
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

describe("collaborator search result merging", () => {
  const members = new Set(["account-member"]);
  const isProjectUser = (account_id: string) => members.has(account_id);

  it("marks comma-separated email invitees and exact email accounts for Select all", () => {
    const acc = emptyCollaboratorSearchResults();
    addCollaboratorQueryResults(acc, "new@example.com", [], isProjectUser);
    addCollaboratorQueryResults(
      acc,
      "alice@example.com",
      [{ account_id: "account-alice", first_name: "Alice" }],
      isProjectUser,
    );
    expect(acc.results.map((x) => x.account_id ?? x.email_address)).toEqual([
      "new@example.com",
      "account-alice",
    ]);
    expect(Array.from(acc.exact_match_keys)).toEqual([
      "new@example.com",
      "account-alice",
    ]);
  });

  it("does not mark name-search matches as exact", () => {
    const acc = emptyCollaboratorSearchResults();
    addCollaboratorQueryResults(
      acc,
      "alice",
      [{ account_id: "account-alice" }, { account_id: "account-alicia" }],
      isProjectUser,
    );
    expect(acc.results).toHaveLength(2);
    expect(acc.exact_match_keys.size).toBe(0);
  });

  it("keeps a name match eligible once an email query matches it exactly", () => {
    const acc = emptyCollaboratorSearchResults();
    addCollaboratorQueryResults(
      acc,
      "alice",
      [{ account_id: "account-alice" }],
      isProjectUser,
    );
    addCollaboratorQueryResults(
      acc,
      "alice@example.com",
      [{ account_id: "account-alice", email_address: "alice@example.com" }],
      isProjectUser,
    );
    expect(acc.results).toEqual([
      { account_id: "account-alice", email_address: "alice@example.com" },
    ]);
    expect(Array.from(acc.exact_match_keys)).toEqual(["account-alice"]);
  });

  it("deduplicates repeated entries", () => {
    const acc = emptyCollaboratorSearchResults();
    for (let i = 0; i < 2; i++) {
      addCollaboratorQueryResults(acc, "new@example.com", [], isProjectUser);
      addCollaboratorQueryResults(
        acc,
        "bob@example.com",
        [{ account_id: "account-bob" }],
        isProjectUser,
      );
    }
    expect(acc.results).toHaveLength(2);
    expect(acc.exact_match_keys.size).toBe(2);
  });

  it("excludes existing collaborators and counts them", () => {
    const acc = emptyCollaboratorSearchResults();
    addCollaboratorQueryResults(
      acc,
      "member@example.com",
      [{ account_id: "account-member" }],
      isProjectUser,
    );
    expect(acc.results).toEqual([]);
    expect(acc.exact_match_keys.size).toBe(0);
    expect(acc.num_already_matching).toBe(1);
  });

  it("adds nothing for an empty name search", () => {
    const acc = emptyCollaboratorSearchResults();
    addCollaboratorQueryResults(acc, "nobody", [], isProjectUser);
    expect(acc.results).toEqual([]);
    expect(acc.exact_match_keys.size).toBe(0);
  });
});
