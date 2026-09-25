import {
  artifactCatalogKey,
  validateArtifactCatalogSnapshot,
} from "../artifact-catalog";

function snapshot(): any {
  return {
    schema_version: 1,
    project_id: "11111111-1111-4111-8111-111111111111",
    chat_path: "/home/user/test.chat",
    epoch: "epoch",
    sequence: 1,
    items: [
      {
        thread_id: "thread",
        artifact_id: "artifact",
        kind: "markdown",
        title: "Notes",
        description: "",
        created_at: 1000,
        publication: { operation_id: "op", message_id: "msg" },
      },
    ],
  };
}

test("catalog validation strips contents, secrets and unknown fields", () => {
  const input = snapshot();
  input.account_id = "not an authenticated account";
  input.items[0].markdown = "document content";
  input.items[0].target = { path: "/home/user/notes.md", token: "credential" };
  const result = validateArtifactCatalogSnapshot(input);
  expect(JSON.stringify(result)).not.toMatch(
    /authenticated|content|credential/,
  );
  expect(result.items[0].target).toEqual({ path: "/home/user/notes.md" });
});

test.each([
  "relative.chat",
  "/home/user/../a.chat",
  "/home//a.chat",
  "/home/user/a.txt",
])("rejects noncanonical source %s", (chat_path) => {
  expect(() =>
    validateArtifactCatalogSnapshot({ ...snapshot(), chat_path }),
  ).toThrow();
});

test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid sequence %s",
  (sequence) => {
    expect(() =>
      validateArtifactCatalogSnapshot({ ...snapshot(), sequence }),
    ).toThrow();
  },
);

test("rejects duplicate identities and oversized fields", () => {
  const input = snapshot();
  input.items.push({ ...input.items[0] });
  expect(() => validateArtifactCatalogSnapshot(input)).toThrow("duplicate");
  input.items.pop();
  input.items[0].title = "x".repeat(513);
  expect(() => validateArtifactCatalogSnapshot(input)).toThrow();
});

test("same artifact id in another thread or project has a different key", () => {
  const input = snapshot();
  const key = artifactCatalogKey(input, input.items[0]);
  expect(
    artifactCatalogKey({ ...input, project_id: "another" }, input.items[0]),
  ).not.toBe(key);
  expect(
    artifactCatalogKey(input, { ...input.items[0], thread_id: "another" }),
  ).not.toBe(key);
});
