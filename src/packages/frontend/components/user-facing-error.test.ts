import { normalizeUserFacingError, stringifyError } from "./user-facing-error";

describe("normalizeUserFacingError", () => {
  it("removes redundant leading Error wrappers", () => {
    expect(
      normalizeUserFacingError("Error - Error: invalid email address").message,
    ).toBe("invalid email address");
    expect(
      normalizeUserFacingError(
        new Error("Error: Error: project.stop projection did not converge"),
      ).message,
    ).toBe("project.stop projection did not converge");
  });

  it("removes callHub suffixes from user-facing messages", () => {
    const raw =
      "must be a project owner to permanently delete a workspace - callHub: subject='hub.account.acct-1.api', name='projects.hardDeleteProject', code='project_delete_not_owner'";
    const normalized = normalizeUserFacingError(raw);

    expect(normalized.message).toBe(
      "must be a project owner to permanently delete a workspace",
    );
    expect(normalized.details).toBe(raw);
  });

  it("extracts nested backend error fields", () => {
    expect(
      normalizeUserFacingError({
        event: { error: "Error: directory already exists" },
      }).message,
    ).toBe("directory already exists");
  });

  it("preserves plain actionable validation text", () => {
    const normalized = normalizeUserFacingError(
      "cannot delete a tier with active subscriptions",
    );

    expect(normalized.message).toBe(
      "cannot delete a tier with active subscriptions",
    );
    expect(normalized.details).toBeUndefined();
  });

  it("uses a generic message when only an internal callHub wrapper remains", () => {
    const raw =
      "callHub: subject='hub.account.acct-1.api', name='projects.start', code='undefined'";
    const normalized = normalizeUserFacingError(raw);

    expect(normalized.message).toBe("The server request failed.");
    expect(normalized.details).toBe(raw);
  });
});

describe("stringifyError", () => {
  it("uses object message fields before JSON fallback", () => {
    expect(stringifyError({ message: "plain message", code: "x" })).toBe(
      "plain message",
    );
  });

  it("falls back to JSON for non-Error objects", () => {
    expect(stringifyError({ error: "bad" })).toBe('{"error":"bad"}');
  });
});
