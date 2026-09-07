import {
  exportTargetReview,
  importTargetReview,
  loadTargetReview,
  saveTargetReview,
  validateReviewTarget,
} from "../git-target-review-store";
import type { TargetReviewStorage } from "../git-target-review-store";
import type { ImmutableReviewTarget } from "@cocalc/frontend/components/diff-viewer/review-model";

jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));

const target: ImmutableReviewTarget = {
  kind: "comparison",
  repository: {
    projectId: "p",
    commonDirectory: "/repo/.git",
    locator: "/repo",
    objectFormat: "sha1",
  },
  mode: "merge-base",
  requestedBase: "a".repeat(40),
  base: "b".repeat(40),
  head: "c".repeat(40),
};
const body = { reviewed: false, note: "review", comments: {} };
let kv: TargetReviewStorage;
let records: Map<string, any>;
beforeEach(() => {
  let id = 0;
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: () => `revision-${++id}`,
  });
  records = new Map();
  kv = {
    keys: async () => [...records.keys()],
    get: async (key) => records.get(key),
    set: async (key, value) => {
      records.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
});
const save = (note: string, parents: string[] = []) =>
  saveTargetReview({
    accountId: "a",
    target,
    body: { ...body, note },
    parents,
    kv,
  });
const load = () => loadTargetReview({ accountId: "a", target, kv });

test("concurrent windows retain both heads until explicitly reconciled", async () => {
  const base = await save("base");
  const left = await save("left", [base.id]);
  const right = await save("right", [base.id]);
  expect((await load()).heads.map((r) => r.body.note).sort()).toEqual([
    "left",
    "right",
  ]);
  await save("reconciled", [left.id, right.id]);
  const result = await load();
  expect(result.heads.map((r) => r.body.note)).toEqual(["reconciled"]);
  expect(exportTargetReview(result.revisions).revisions).toHaveLength(4);
});

test("worktree locators share reviews but accounts, repositories, modes, and endpoints do not", async () => {
  await save("shared");
  const otherWorktree = {
    ...target,
    repository: { ...target.repository, locator: "/feature" },
  };
  expect(
    (await loadTargetReview({ accountId: "a", target: otherWorktree, kv }))
      .heads,
  ).toHaveLength(1);
  for (const different of [
    { ...target, mode: "trees" as const },
    { ...target, head: "d".repeat(40) },
    { ...target, repository: { ...target.repository, projectId: "q" } },
  ])
    expect(
      (await loadTargetReview({ accountId: "a", target: different, kv })).heads,
    ).toEqual([]);
  expect(
    (await loadTargetReview({ accountId: "b", target, kv })).heads,
  ).toEqual([]);
});

test("merge-parent reviews are distinct from one another and from comparisons", async () => {
  const commit = {
    kind: "commit" as const,
    repository: target.repository,
    commit: target.head,
    parent: target.base,
    parentIndex: 0,
  };
  await saveTargetReview({
    accountId: "a",
    target: commit,
    body,
    parents: [],
    kv,
  });
  expect(
    (
      await loadTargetReview({
        accountId: "a",
        target: { ...commit, parentIndex: 1 },
        kv,
      })
    ).heads,
  ).toEqual([]);
  expect((await load()).heads).toEqual([]);
});

test("pins are validated against object format and root parent identity", () => {
  expect(() => validateReviewTarget({ ...target, head: "main" })).toThrow();
  expect(() =>
    validateReviewTarget({ ...target, head: "c".repeat(64) }),
  ).toThrow();
  expect(() =>
    validateReviewTarget({
      ...target,
      repository: { ...target.repository, objectFormat: "sha256" },
      base: "a".repeat(64),
      head: "b".repeat(64),
      requestedBase: "c".repeat(64),
    }),
  ).not.toThrow();
  expect(() =>
    validateReviewTarget({
      kind: "commit",
      repository: target.repository,
      commit: target.head,
      parent: null,
      parentIndex: 0,
    }),
  ).not.toThrow();
  expect(() =>
    validateReviewTarget({
      kind: "commit",
      repository: target.repository,
      commit: target.head,
      parent: null,
      parentIndex: 1,
    }),
  ).toThrow();
});

test("failed saves and missing parents cannot replace existing review snapshots", async () => {
  const base = await save("base");
  await expect(save("bad", ["missing"])).rejects.toThrow();
  kv.set = async () => {
    throw Error("offline");
  };
  await expect(save("offline", [base.id])).rejects.toThrow("offline");
  expect((await load()).heads.map((r) => r.body.note)).toEqual(["base"]);
});

test("submission and image Markdown fields survive snapshot export", async () => {
  const comment = {
    id: "c",
    file_path: " a.md ",
    side: "old" as const,
    line: 2,
    body_md: "![image](/blobs/image.png)",
    status: "submitted" as const,
    submitted_at: 123,
    submission_turn_id: "turn",
    created_at: 1,
    updated_at: 2,
    local_revision: 3,
  };
  await saveTargetReview({
    accountId: "a",
    target,
    body: {
      ...body,
      comments: { c: comment },
      last_submitted_at: 123,
      last_submission_turn_id: "turn",
    },
    parents: [],
    kv,
  });
  const exported = exportTargetReview((await load()).revisions);
  expect(exported.revisions[0].body.comments.c).toMatchObject(comment);
  expect(exported.revisions[0].body.last_submission_turn_id).toBe("turn");
});

test("archive import preserves conflicts and rejects incomplete graphs before writing", async () => {
  const base = await save("base");
  await save("one", [base.id]);
  await save("two", [base.id]);
  const payload = exportTargetReview((await load()).revisions);
  records.clear();
  await importTargetReview({ accountId: "a", target, payload, kv });
  expect((await load()).heads.map((r) => r.body.note).sort()).toEqual([
    "one",
    "two",
  ]);
  const before = records.size;
  await expect(
    importTargetReview({
      accountId: "a",
      target,
      payload: { ...payload, revisions: payload.revisions.slice(1) },
      kv,
    }),
  ).rejects.toThrow("missing a parent");
  expect(records.size).toBe(before);
  await importTargetReview({ accountId: "a", target, payload, kv });
  expect(records.size).toBe(before * 2);
  expect((await load()).heads).toHaveLength(4);
});

test("corrupt revision ancestry fails visibly rather than hiding comments", async () => {
  const first = await save("first");
  const second = await save("second", [first.id]);
  const root = [...records.values()].find((record) => record.id === first.id);
  root.parents = [second.id];
  await expect(load()).rejects.toThrow("Cyclic");
  root.parents = ["missing"];
  await expect(load()).rejects.toThrow("missing a parent");
  expect(records.size).toBe(2);
});
