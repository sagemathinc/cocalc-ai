import {
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
