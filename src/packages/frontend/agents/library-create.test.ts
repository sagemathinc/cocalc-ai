/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  buildArtifactContent,
  createLibraryArtifact,
  fetchGitHubPR,
  libraryChatPath,
} from "./library-create";

const files = new Set<string>();
let rows: any[] = [];
const fakeSyncdb = {
  get: (where: any) =>
    rows.filter((row) =>
      Object.entries(where).every(([key, value]) => row[key] === value),
    ),
  get_one: (where: any) =>
    rows.find((row) =>
      Object.entries(where).every(([key, value]) => row[key] === value),
    ),
  set: (row: any) => rows.push(...(Array.isArray(row) ? row : [row])),
  commit: jest.fn(),
  save: jest.fn(async () => {}),
};
let created = 0;
const fakeChat = {
  syncdb: fakeSyncdb,
  createEmptyThread: jest.fn(({ name }) => {
    const thread_id = `thread-${++created}`;
    rows.push({ event: "chat-thread-config", thread_id, name });
    return thread_id;
  }),
  sendChat: jest.fn(({ input, reply_thread_id }) => {
    rows.push({
      event: "chat",
      thread_id: reply_thread_id,
      message_id: `message-${rows.length}`,
      date: new Date(Date.now() + rows.length).toISOString(),
      history: [{ content: input }],
    });
  }),
  save_to_disk: jest.fn(async () => {}),
};

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getProjectActions: () => ({
      ensureContainingDirectoryExists: jest.fn(async () => {}),
      fs: () => ({
        exists: async (p: string) => files.has(p),
        writeFile: async (p: string) => files.add(p),
      }),
    }),
  },
}));
jest.mock("@cocalc/frontend/app-framework/project-runtime", () => ({
  ensureProjectReduxRuntime: async () => {},
}));
jest.mock("@cocalc/frontend/project/home-directory", () => ({
  resolveProjectHomeDirectory: async () => "/home/user",
}));
jest.mock("@cocalc/frontend/chat/register", () => ({
  initChat: () => fakeChat,
  removeWithInstance: jest.fn(),
}));
jest.mock("@cocalc/frontend/people/create", () => ({
  waitForChatReady: async () => {},
}));

beforeEach(() => {
  rows = [];
  files.clear();
  created = 0;
  jest.clearAllMocks();
});

test("a hand-made artifact is published from a message in the project's Library thread", async () => {
  const first = await createLibraryArtifact({
    project_id: "p",
    content: { title: "Plan", markdown: "# Plan" },
  });
  expect(first.path).toBe(libraryChatPath("/home/user"));
  expect(first.path).toBe("/home/user/.cocalc/library.chat");
  expect(files.has(first.path)).toBe(true);
  const artifact = rows.find((row) => row.event === "chat-artifact");
  expect(artifact).toMatchObject({
    thread_id: first.thread_id,
    artifact_id: first.artifact_id,
    kind: "markdown",
    title: "Plan",
  });
  const publication = rows.find(
    (row) => row.event === "chat-artifact-publication",
  );
  const message = rows.find((row) => row.event === "chat");
  expect(publication.message_id).toBe(message.message_id);
  expect(message.history[0].content).toBe("Added **Plan** to the library.");
  // The second one reuses the Library thread.
  const second = await createLibraryArtifact({
    project_id: "p",
    content: { title: "Data", markdown: "", file: { path: "out/data.csv" } },
  });
  expect(second.thread_id).toBe(first.thread_id);
  expect(fakeChat.createEmptyThread).toHaveBeenCalledTimes(1);
  // Relative file paths are in the project's home directory.
  expect(rows.filter((row) => row.event === "chat-artifact")[1].file).toEqual({
    path: "/home/user/out/data.csv",
  });
});

test("form contents become artifacts, with clear errors", () => {
  expect(() => buildArtifactContent("markdown", { title: " " })).toThrow(
    "title",
  );
  expect(buildArtifactContent("file", { title: "", path: "a/b.png" })).toEqual({
    title: "b.png",
    markdown: "",
    file: { path: "a/b.png" },
  });
  const list = buildArtifactContent("actions", {
    title: "",
    decisions: "Ship it\n\n  Write docs ",
  });
  expect(list.title).toBe("Decisions");
  expect(list.actions?.map((a) => [a.id, a.title])).toEqual([
    ["item-1", "Ship it"],
    ["item-2", "Write docs"],
  ]);
  expect(() => buildArtifactContent("github-pr", { title: "" })).toThrow(
    "Look up",
  );
});

test("a GitHub PR is looked up for its state and revisions", async () => {
  const sha = (c: string) => c.repeat(40);
  (global as any).fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      title: "Fix it",
      body: "Details",
      state: "closed",
      merged_at: "2026-10-01T00:00:00Z",
      draft: false,
      base: { sha: sha("a") },
      head: { sha: sha("b") },
    }),
  }));
  const pr = await fetchGitHubPR("https://github.com/owner/repo/pull/12");
  expect((global as any).fetch).toHaveBeenCalledWith(
    "https://api.github.com/repos/owner/repo/pulls/12",
    expect.anything(),
  );
  expect(pr.title).toBe("Fix it");
  expect(pr.github_pr).toMatchObject({
    repository: "owner/repo",
    number: 12,
    state: "merged",
    base_sha: sha("a"),
    head_sha: sha("b"),
  });
  await expect(fetchGitHubPR("not a url")).rejects.toThrow("GitHub");
});
