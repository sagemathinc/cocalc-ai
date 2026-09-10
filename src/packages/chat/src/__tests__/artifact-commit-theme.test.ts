import {
  artifactKey,
  publishArtifact,
  readArtifact,
  validateArtifactCommit,
  validateArtifactTheme,
} from "../artifacts";
const commit = {
  sha: "a".repeat(40),
  path: "/repo/worktree",
  common_directory: "/repo/.git",
  branch: "topic",
};
const theme = {
  title: "Review",
  description: "A durable review",
  color: "#123456",
  accent_color: null,
  icon: "git",
  image_blob: null,
};
const input = {
  thread_id: "thread",
  artifact_id: "commit",
  operation_id: "publish",
  message_id: "message",
  title: "Commit",
  markdown: "Summary",
  commit,
  theme,
};
test("commit identity and theme survive publication, retry, and content updates", () => {
  const rows = new Map<string, any>();
  const key = (v: any) => JSON.stringify([v.event, v.sender_id, v.thread_id]);
  const db = {
    get_one: (k: object) => rows.get(key(k)),
    set: (values: any) => {
      for (const v of Array.isArray(values) ? values : [values])
        rows.set(key(v), { ...rows.get(key(v)), ...v });
    },
  };
  const first = publishArtifact(db, input);
  expect(first.publication.snapshot.commit).toEqual(commit);
  expect(first.publication.snapshot.theme).toEqual(theme);
  db.set({ ...artifactKey(input), theme: { ...theme, title: "User title" } });
  expect(publishArtifact(db, input).replayed).toBe(true);
  const { base } = readArtifact(db, input);
  const second = publishArtifact(db, {
    ...input,
    theme: undefined,
    operation_id: "update",
    markdown: "Revised",
    base,
  });
  expect(second.artifact.theme?.title).toBe("User title");
  expect(second.artifact.kind).toBe("commit");
  expect(() =>
    publishArtifact(db, {
      ...input,
      operation_id: "conflict",
      base: first.base,
    }),
  ).toThrow(/changed/);
  expect(() =>
    publishArtifact(db, {
      ...input,
      operation_id: "mixed",
      file: { path: "/x" },
    }),
  ).toThrow(/mix/);
});
test.each([
  { ...commit, sha: "HEAD" },
  { ...commit, path: "/repo/../other" },
  { ...commit, common_directory: "relative" },
])("rejects ambiguous commit locators", (value) => {
  expect(() => validateArtifactCommit(value)).toThrow();
});
test.each([
  { ...theme, color: "url(x)" },
  { ...theme, image_blob: "https://other/image" },
  { ...theme, icon: "<script>" },
])("rejects non-data appearance", (value) => {
  expect(() => validateArtifactTheme(value)).toThrow();
});
