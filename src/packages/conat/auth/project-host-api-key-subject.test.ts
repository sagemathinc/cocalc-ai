import {
  apiKeyViewerFsSubject,
  parseApiKeyViewerFsSubject,
} from "./project-host-api-key-subject";

describe("API key viewer filesystem subject", () => {
  const value = {
    project_id: "00000000-0000-4000-8000-000000000001",
    account_id: "00000000-0000-4000-8000-000000000002",
    key_id: "key-id-123",
    scope_revision: 4,
    viewer_policy_hash: "a".repeat(64),
  };

  it("round-trips only canonical exact subjects", () => {
    const subject = apiKeyViewerFsSubject(value);
    expect(parseApiKeyViewerFsSubject(subject)).toEqual(value);
    expect(parseApiKeyViewerFsSubject(`${subject}.extra`)).toBeUndefined();
    expect(
      parseApiKeyViewerFsSubject(subject.replace("rev-4", "rev-04")),
    ).toBeUndefined();
    expect(
      parseApiKeyViewerFsSubject(subject.replace("key-id-123", "other")),
    ).toBeUndefined();
  });
});
