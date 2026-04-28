import { isCollaboratorRealtimeAccessError } from "./collaborator-realtime";

describe("isCollaboratorRealtimeAccessError", () => {
  it("matches project-scoped lro collaborator failures", () => {
    expect(
      isCollaboratorRealtimeAccessError(
        new Error("user must be a collaborator on project"),
      ),
    ).toBe(true);
  });

  it("matches project status subscribe permission failures", () => {
    expect(
      isCollaboratorRealtimeAccessError(
        new Error(
          'permission denied subscribing to \'project.abc.project-status.-\' from {"account_id":"acct"}',
        ),
      ),
    ).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(
      isCollaboratorRealtimeAccessError(new Error("temporary network timeout")),
    ).toBe(false);
  });
});
