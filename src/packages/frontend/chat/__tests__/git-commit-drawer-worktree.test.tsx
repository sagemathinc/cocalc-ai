import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useRef } from "react";
import { GitCommitDrawer } from "../git-commit-drawer";
import { projectGitReader } from "@cocalc/frontend/git/project-read-service";
import { locateCommitWorktree } from "@cocalc/frontend/git/commit-worktree";
import { readTargetDiff } from "@cocalc/frontend/git/read-target-diff";
import { loadReviewRecord } from "../git-review-store";
import { parseGitShowOutput } from "../git-commit/git-output";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const mockOpenFile = jest.fn().mockResolvedValue(undefined);
const mockDiffMount = jest.fn();
const mockDiffUnmount = jest.fn();
const mockDiffRender = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  ...jest.requireActual("react"),
  useTypedRedux: () => "account",
  redux: { getProjectActions: () => ({ open_file: mockOpenFile }) },
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    project_client: { exec: jest.fn() },
    conat_client: { on: jest.fn(), removeListener: jest.fn() },
    on: jest.fn(),
    removeListener: jest.fn(),
  },
}));
jest.mock("@cocalc/frontend/alerts", () => ({ alert_message: jest.fn() }));
jest.mock(
  "@cocalc/frontend/project/workspaces/use-effective-editor-theme",
  () => ({ useEffectiveEditorThemeForPath: () => "default" }),
);
jest.mock("@cocalc/frontend/git/project-read-service", () => ({
  projectGitReader: {
    discover: jest.fn(),
    resolveCommit: jest.fn(),
    pinCommit: jest.fn(),
    history: jest.fn(),
  },
}));
jest.mock("@cocalc/frontend/git/commit-worktree", () => ({
  locateCommitWorktree: jest.fn(),
}));
jest.mock("@cocalc/frontend/git/read-target-diff", () => ({
  readTargetDiff: jest.fn(),
}));
jest.mock("../git-review-store", () => ({
  normalizeCommitSha: (commit?: string) => commit?.toLowerCase(),
  loadReviewRecord: jest.fn(),
  loadReviewRecords: jest.fn().mockResolvedValue([]),
  loadReviewDraft: jest.fn(),
}));
jest.mock("antd", () => ({
  ...jest.requireActual("antd"),
  Drawer: ({ children, title, extra, open }: any) =>
    open ? (
      <div>
        {title}
        {extra}
        {children}
      </div>
    ) : null,
}));
jest.mock("../git-commit/comparison-modal", () => ({
  ComparisonModal: () => null,
}));
jest.mock("../git-commit/feedback-destination", () => ({
  useFeedbackDestination: () => ({ request: jest.fn(), modal: null }),
}));
jest.mock(
  "@cocalc/frontend/frame-editors/time-travel-editor/git-revision-modal",
  () => ({ GitRevisionModal: () => null }),
);
jest.mock("../git-commit/review-title", () => ({ GitReviewTitle: () => null }));
jest.mock("../git-commit/review-alias-choice", () => ({
  ReviewAliasChoice: () => null,
}));
jest.mock("../git-commit/review-editors", () => ({
  buildGitReviewEditorScope: ({ accountId, commitSha }: any) =>
    `${accountId}:${commitSha}`,
  buildGitReviewNoteEditorId: (scope: string) => scope,
}));
jest.mock("../git-commit/drawer-sections", () => ({
  GitCommitDrawerTitle: ({ onContextChange, onCommitChange }: any) => (
    <>
      <button onClick={() => onContextChange(20)}>More context</button>
      <button onClick={() => onCommitChange("b".repeat(40))}>
        Next commit
      </button>
    </>
  ),
  DeleteAllReviewsModal: () => null,
  GitChangedFilesPanel: () => null,
  GitCommitDetailsPanel: () => null,
  GitDiffListFooterSpacer: () => null,
  GitEmptyCommitDiff: () => <div>Empty diff</div>,
  GitHeadCommitPanel: () => null,
  GitRepoBootstrapPanel: () => null,
  GitReviewPanel: () => null,
}));
jest.mock(
  "@cocalc/frontend/components/diff-viewer/changed-files-layout",
  () => ({
    ChangedFilesLayout: ({ children, expansionScope }: any) => (
      <section aria-label="Changed files" data-scope={expansionScope}>
        {children}
      </section>
    ),
  }),
);
jest.mock("../git-commit/history-controls", () => ({
  GitHistoryControls: ({ selection, origin, onApply }: any) => (
    <div>
      <output aria-label="Selected worktree">{selection.worktree}</output>
      <button
        onClick={() =>
          onApply(
            { ...selection, worktree: "/other", ref: "refs/heads/feature" },
            {
              ...origin,
              repository: { ...origin.repository, locator: "/other" },
            },
            "HEAD",
          )
        }
      >
        Other working copy
      </button>
    </div>
  ),
}));
jest.mock("../git-commit/review-diff-panel", () => ({
  ReviewDiffPanel: function MockDiff(props: any) {
    mockDiffRender(props);
    const viewport = useRef<HTMLDivElement>(null);
    useEffect(() => {
      mockDiffMount();
      return () => {
        mockDiffUnmount();
      };
    }, []);
    useEffect(() => {
      // Model the viewer's scope-dependent reading-position restoration.
      viewport.current!.scrollTop = 0;
    }, [props.scrollScope]);
    return (
      <div ref={viewport} role="region" aria-label="Git diff" tabIndex={0}>
        <span>{props.files[0].lines.join("\n")}</span>
        <button onClick={() => props.onOpenFile("file.ts")}>
          Open working file
        </button>
      </div>
    );
  },
}));

const commit = "a".repeat(40);
const nextCommit = "b".repeat(40);
const repository = {
  projectId: "project",
  locator: "/repo",
  commonDirectory: "/repo/.git",
  objectFormat: "sha1" as const,
};
const discovery = {
  repository,
  worktrees: [
    { path: "/repo", head: nextCommit, branch: "refs/heads/main" },
    { path: "/other", head: commit, branch: "refs/heads/feature" },
  ],
  refs: [],
};
const props = {
  projectId: "project",
  sourcePath: "/repo/x.chat",
  open: true,
  onClose: jest.fn(),
  commitHash: commit,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  jest
    .mocked(projectGitReader.discover)
    .mockImplementation(async (projectId, path) => ({
      ...discovery,
      repository: { ...repository, projectId, locator: path },
    }));
  jest.mocked(projectGitReader.resolveCommit).mockResolvedValue(nextCommit);
  jest.mocked(projectGitReader.history).mockResolvedValue([]);
  jest
    .mocked(locateCommitWorktree)
    .mockResolvedValue({ kind: "current", commit });
  jest
    .mocked(projectGitReader.pinCommit)
    .mockImplementation(async (repository, input) => ({
      kind: "commit",
      repository,
      commit: input === commit.slice(0, 8) ? commit : input,
      parent: null,
      parentIndex: 0,
    }));
  jest
    .mocked(readTargetDiff)
    .mockImplementation(async (_reader, target) =>
      parseGitShowOutput(
        `commit ${target.kind === "commit" ? target.commit : ""}\n\n    Example commit\n\ndiff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n`,
        target.repository.locator,
      ),
    );
  jest.mocked(loadReviewRecord).mockImplementation(
    async ({ commitSha }) =>
      ({
        account_id: "account",
        commit_sha: commitSha,
        comments: {},
        note: "review note",
        reviewed: false,
      }) as any,
  );
  jest
    .mocked(webapp_client.project_client.exec)
    .mockResolvedValue({ exit_code: 0, stdout: "" } as any);
});

test.each([commit, commit.slice(0, 8)])(
  "late worktree discovery preserves the mounted diff for %s",
  async (commitHash) => {
    const lookup = deferred<Awaited<ReturnType<typeof locateCommitWorktree>>>();
    jest.mocked(locateCommitWorktree).mockReturnValue(lookup.promise);
    const selectionChanged = jest.fn();
    render(
      <GitCommitDrawer
        {...props}
        commitHash={commitHash}
        onSelectedCommitChange={selectionChanged}
      />,
    );
    const viewport = await screen.findByRole("region", { name: "Git diff" });
    await waitFor(() =>
      expect(selectionChanged).toHaveBeenLastCalledWith(
        commit,
        "/repo",
        undefined,
      ),
    );
    viewport.scrollTop = 1234;
    viewport.focus();
    const files = mockDiffRender.mock.lastCall![0].files;
    const scope = screen.getByRole("region", { name: "Changed files" }).dataset
      .scope;
    const reviewLoads = jest.mocked(loadReviewRecord).mock.calls.length;
    const mounts = mockDiffMount.mock.calls.length;
    const unmounts = mockDiffUnmount.mock.calls.length;
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
    await act(async () =>
      lookup.resolve({
        kind: "unique",
        commit,
        selection: {
          worktree: "/other",
          ref: "refs/heads/feature",
          firstParent: false,
        },
        tip: commit,
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Selected worktree").textContent).toBe(
        "/other",
      ),
    );
    expect(screen.getByRole("region", { name: "Git diff" })).toBe(viewport);
    expect(viewport.scrollTop).toBe(1234);
    expect(document.activeElement).toBe(viewport);
    expect(mockDiffRender.mock.lastCall![0].files).toBe(files);
    expect(mockDiffMount).toHaveBeenCalledTimes(mounts);
    expect(mockDiffUnmount).toHaveBeenCalledTimes(unmounts);
    expect(
      screen.getByRole("region", { name: "Changed files" }).dataset.scope,
    ).toBe(scope);
    expect(readTargetDiff).toHaveBeenCalledTimes(1);
    expect(loadReviewRecord).toHaveBeenCalledTimes(reviewLoads);
    fireEvent.click(screen.getByRole("button", { name: "Open working file" }));
    expect(mockOpenFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "/other/file.ts" }),
    );
  },
);

test("history arriving after a short-hash diff does not replace it", async () => {
  const history =
    deferred<Awaited<ReturnType<typeof projectGitReader.history>>>();
  jest.mocked(projectGitReader.history).mockReturnValue(history.promise);
  render(<GitCommitDrawer {...props} commitHash={commit.slice(0, 8)} />);
  const viewport = await screen.findByRole("region", { name: "Git diff" });
  viewport.scrollTop = 456;
  viewport.focus();
  await act(async () =>
    history.resolve([
      { commit, parents: [], subject: "Example commit", timestamp: 0 },
    ]),
  );
  expect(screen.getByRole("region", { name: "Git diff" })).toBe(viewport);
  expect(document.activeElement).toBe(viewport);
  expect(viewport.scrollTop).toBe(456);
  expect(readTargetDiff).toHaveBeenCalledTimes(1);
  expect(mockDiffMount).toHaveBeenCalledTimes(1);
});

test("worktree discovery does not cancel an immutable diff still in flight", async () => {
  const lookup = deferred<Awaited<ReturnType<typeof locateCommitWorktree>>>();
  const pending = deferred<Awaited<ReturnType<typeof readTargetDiff>>>();
  jest.mocked(locateCommitWorktree).mockReturnValue(lookup.promise);
  jest.mocked(readTargetDiff).mockReturnValueOnce(pending.promise);
  render(<GitCommitDrawer {...props} />);
  await waitFor(() => expect(readTargetDiff).toHaveBeenCalledTimes(1));
  await act(async () =>
    lookup.resolve({
      kind: "unique",
      commit,
      selection: {
        worktree: "/other",
        ref: "refs/heads/feature",
        firstParent: false,
      },
      tip: commit,
    }),
  );
  await act(async () => pending.resolve(parseGitShowOutput("", "/repo")));
  await screen.findByText("Empty diff");
  expect(readTargetDiff).toHaveBeenCalledTimes(1);
  expect(projectGitReader.pinCommit).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("Selected worktree").textContent).toBe("/other");
});

test("changing context and selecting a different commit still reload the diff", async () => {
  render(<GitCommitDrawer {...props} />);
  await screen.findByRole("region", { name: "Git diff" });
  fireEvent.click(screen.getByRole("button", { name: "More context" }));
  await waitFor(() => expect(readTargetDiff).toHaveBeenCalledTimes(2));
  await screen.findByRole("region", { name: "Git diff" });
  expect(jest.mocked(readTargetDiff).mock.lastCall![2]).toBe(20);
  fireEvent.click(screen.getByRole("button", { name: "Next commit" }));
  await waitFor(() => expect(readTargetDiff).toHaveBeenCalledTimes(3));
  await screen.findByRole("region", { name: "Git diff" });
  expect(jest.mocked(readTargetDiff).mock.lastCall![1]).toMatchObject({
    commit: nextCommit,
  });
});

test.each(["project", "repository"])(
  "same hash in a different %s cannot reuse the old diff",
  async (change) => {
    const { rerender } = render(<GitCommitDrawer {...props} />);
    await screen.findByRole("region", { name: "Git diff" });
    const pending = deferred<Awaited<ReturnType<typeof readTargetDiff>>>();
    jest.mocked(readTargetDiff).mockReturnValueOnce(pending.promise);
    rerender(
      <GitCommitDrawer
        {...props}
        {...(change === "project"
          ? { projectId: "another-project" }
          : { sourcePath: "/another-repo/x.chat" })}
      />,
    );
    expect(screen.queryByRole("region", { name: "Git diff" })).toBeNull();
    await waitFor(() => expect(readTargetDiff).toHaveBeenCalledTimes(2));
    const target = jest.mocked(readTargetDiff).mock.lastCall![1];
    expect(target.repository).toMatchObject(
      change === "project"
        ? { projectId: "another-project" }
        : { locator: "/another-repo" },
    );
  },
);

test.each(["success", "failure"])(
  "late %s from an earlier selection does not disturb the new diff",
  async (outcome) => {
    const pending = deferred<Awaited<ReturnType<typeof readTargetDiff>>>();
    jest.mocked(readTargetDiff).mockReturnValueOnce(pending.promise);
    render(<GitCommitDrawer {...props} />);
    await waitFor(() => expect(readTargetDiff).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Next commit" }));
    const viewport = await screen.findByRole("region", { name: "Git diff" });
    viewport.scrollTop = 234;
    await act(async () => {
      if (outcome === "failure") pending.reject(Error("Old request failed"));
      else pending.resolve(parseGitShowOutput("", "/repo"));
    });
    expect(screen.getByRole("region", { name: "Git diff" })).toBe(viewport);
    expect(viewport.scrollTop).toBe(234);
    expect(screen.queryByText("Old request failed")).toBeNull();
  },
);

test("uncommitted changes still load from the selected working copy", async () => {
  render(<GitCommitDrawer {...props} commitHash="HEAD" />);
  await screen.findByText("Empty diff");
  jest.mocked(webapp_client.project_client.exec).mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Other working copy" }));
  await waitFor(() =>
    expect(webapp_client.project_client.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/other",
        args: expect.arrayContaining(["diff"]),
      }),
    ),
  );
  expect(readTargetDiff).not.toHaveBeenCalled();
});
