import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TargetReviewPane } from "./target-review-pane";
import {
  loadTargetReview,
  saveTargetReview,
  importTargetReview,
  exportTargetReview,
} from "../git-target-review-store";
import type { ImmutableReviewTarget } from "@cocalc/frontend/components/diff-viewer/review-model";
import { validateAgentWorktree } from "@cocalc/frontend/git/agent-worktree";

jest.mock("@cocalc/frontend/git/project-read-service", () => ({
  projectGitReader: {
    invalidateDiscovery: jest.fn(),
    discover: jest.fn(async () => ({
      worktrees: [{ path: "/repo", branch: "refs/heads/main" }],
    })),
  },
}));
jest.mock("@cocalc/frontend/git/agent-worktree", () => ({
  ...jest.requireActual("@cocalc/frontend/git/agent-worktree"),
  validateAgentWorktree: jest.fn(),
}));
let mockViewerProps: any;
jest.mock("@cocalc/frontend/git/read-target-diff", () => ({
  readTargetDiff: async () => ({
    files: [
      {
        path: "needle.ts",
        lines: ["@@ -1 +1 @@", "-needle", "+needle"],
        oldSource: {
          kind: "git",
          repository: target.repository,
          commit: target.base,
          path: "old-name.ts",
        },
        newSource: {
          kind: "git",
          repository: target.repository,
          commit: target.head,
          path: "needle.ts",
        },
      },
    ],
    linesTruncated: false,
  }),
}));
jest.mock("../git-target-review-store", () => ({
  loadTargetReview: jest.fn(),
  saveTargetReview: jest.fn(),
  importTargetReview: jest.fn().mockResolvedValue(1),
  exportTargetReview: jest.fn((revisions) => ({ revisions })),
}));
jest.mock("./pierre-review-panel", () => ({
  __esModule: true,
  default: (props: any) => {
    mockViewerProps = props;
    return <div>Diff</div>;
  },
}));
jest.mock(
  "@cocalc/frontend/components/diff-viewer/changed-files-layout",
  () => ({ ChangedFilesLayout: ({ children }: any) => children }),
);
const target: ImmutableReviewTarget = {
  kind: "comparison",
  repository: {
    projectId: "p",
    locator: "/repo",
    commonDirectory: "/repo/.git",
    objectFormat: "sha1",
  },
  mode: "trees",
  base: "a".repeat(40),
  requestedBase: "a".repeat(40),
  head: "b".repeat(40),
};
const props = {
  target,
  accountId: "a",
  fontSize: 14,
  onView: jest.fn(),
  onEditing: jest.fn(),
  onLeave: jest.fn(),
};
test("historical side opening preserves renamed path and endpoint", async () => {
  render(<TargetReviewPane {...props} />);
  await screen.findByText("Diff");
  mockViewerProps.onViewFile("needle.ts", "old");
  expect(props.onView).toHaveBeenLastCalledWith({
    kind: "git",
    repository: target.repository,
    commit: target.base,
    path: "old-name.ts",
  });
  mockViewerProps.onViewFile("needle.ts");
  expect(props.onView).toHaveBeenLastCalledWith({
    kind: "git",
    repository: target.repository,
    commit: target.head,
    path: "needle.ts",
  });
});
beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
  jest.mocked(validateAgentWorktree).mockResolvedValue({
    projectId: "p",
    commonDirectory: "/repo/.git",
    workingDirectory: "/repo",
    expectedHead: "b".repeat(40),
    reviewedCommit: "b".repeat(40),
    expectedBranch: "refs/heads/main",
  });
  let id = 0;
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: () => `id-${++id}`,
  });
  jest.mocked(loadTargetReview).mockResolvedValue({ heads: [], revisions: [] });
  jest
    .mocked(saveTargetReview)
    .mockImplementation(async ({ body, parents }) => ({
      version: 1,
      accountId: "a",
      target,
      id: "saved",
      parents,
      body,
      updatedAt: 1,
    }));
});

function savedFeedback() {
  const body = { reviewed: false, note: "Please address this", comments: {} };
  const revision = {
    version: 1 as const,
    accountId: "a",
    target,
    id: "saved",
    parents: [],
    body,
    updatedAt: 1,
  };
  jest
    .mocked(loadTargetReview)
    .mockResolvedValue({ heads: [revision], revisions: [revision] });
  return revision;
}

test("saved comparison feedback requires keyboard opt-in and carries pinned endpoints", async () => {
  savedFeedback();
  const send = jest.fn();
  const user = userEvent.setup();
  render(<TargetReviewPane {...props} onRequestAgentTurn={send} />);
  const button = await screen.findByRole("button", {
    name: "Send saved review to agent",
  });
  expect(button).toBeDisabled();
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Comparison review note" }),
    ).toHaveValue("Please address this"),
  );
  screen.getByRole("checkbox", { name: /Send agent feedback in/ }).focus();
  await user.keyboard(" ");
  expect(button).toBeEnabled();
  await user.click(button);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(send.mock.calls[0][0]).toContain(target.head);
  expect(send.mock.calls[0][0]).toContain(target.base);
  expect(send.mock.calls[0][1]).toEqual({
    title: "Address comparison review",
    workingDirectory: "/repo",
  });
  await waitFor(() => expect(saveTargetReview).toHaveBeenCalled());
  expect(
    jest.mocked(saveTargetReview).mock.calls[0][0].body.last_submitted_at,
  ).toEqual(expect.any(Number));
});

test("origin-thread feedback works without worktree consent or matching HEAD", async () => {
  savedFeedback();
  jest.mocked(validateAgentWorktree).mockRejectedValue(Error("HEAD differs"));
  const send = jest.fn();
  const user = userEvent.setup();
  render(
    <TargetReviewPane
      {...props}
      feedbackToOriginThread
      onRequestAgentTurn={send}
    />,
  );
  const button = await screen.findByRole("button", {
    name: "Send saved review to agent",
  });
  await waitFor(() => expect(button).toBeEnabled());
  expect(
    screen.queryByRole("checkbox", { name: /Send agent feedback in/ }),
  ).toBeNull();
  button.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(send.mock.calls[0][0]).toContain(target.base);
  expect(send.mock.calls[0][0]).toContain(target.head);
  expect(validateAgentWorktree).not.toHaveBeenCalled();
});

test("changed saved heads prevent comparison dispatch", async () => {
  savedFeedback();
  const send = jest.fn();
  const user = userEvent.setup();
  render(<TargetReviewPane {...props} onRequestAgentTurn={send} />);
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Comparison review note" }),
    ).toBeEnabled(),
  );
  await user.click(
    screen.getByRole("checkbox", { name: /Send agent feedback in/ }),
  );
  jest.mocked(loadTargetReview).mockResolvedValue({ heads: [], revisions: [] });
  await user.click(
    screen.getByRole("button", { name: "Send saved review to agent" }),
  );
  await screen.findByText(/saved review changed/);
  expect(send).not.toHaveBeenCalled();
});

test("a failed receipt save retains a draft and warns against resending", async () => {
  savedFeedback();
  jest.mocked(saveTargetReview).mockRejectedValue(Error("offline"));
  const send = jest.fn();
  const user = userEvent.setup();
  render(<TargetReviewPane {...props} onRequestAgentTurn={send} />);
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Comparison review note" }),
    ).toBeEnabled(),
  );
  await user.click(
    screen.getByRole("checkbox", { name: /Send agent feedback in/ }),
  );
  await user.click(
    screen.getByRole("button", { name: "Send saved review to agent" }),
  );
  await screen.findByText(/Feedback was sent, but saving its receipt failed/);
  expect(send).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("button", { name: "Send saved review to agent" }),
  ).toBeDisabled();
  expect(
    Object.values(localStorage).some((value) =>
      String(value).includes("last_submission_turn_id"),
    ),
  ).toBe(true);
});

test("unsaved review survives unmount and explicit recovery without writing a commit review", async () => {
  const user = userEvent.setup();
  const first = render(<TargetReviewPane {...props} />);
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Comparison review note" }),
    ).toBeEnabled(),
  );
  await user.type(
    screen.getByRole("textbox", { name: "Comparison review note" }),
    "offline note",
  );
  await user.click(
    screen.getByRole("button", { name: "Keep local draft and close" }),
  );
  expect(props.onLeave).toHaveBeenCalled();
  first.unmount();
  render(<TargetReviewPane {...props} />);
  await user.click(
    await screen.findByRole("button", { name: "Recover local draft 1" }),
  );
  expect(
    screen.getByRole("textbox", { name: "Comparison review note" }),
  ).toHaveValue("offline note");
  await user.click(screen.getByRole("button", { name: "Save review" }));
  await waitFor(() =>
    expect(saveTargetReview).toHaveBeenCalledWith(
      expect.objectContaining({
        target,
        body: expect.objectContaining({ note: "offline note" }),
      }),
    ),
  );
});

test("concurrent heads are reconciled only by an explicit action", async () => {
  const user = userEvent.setup();
  const versions = ["left", "right"].map((id) => ({
    version: 1 as const,
    accountId: "a",
    target,
    id,
    parents: [],
    updatedAt: 1,
    body: { note: id, reviewed: false, comments: {} },
  }));
  jest
    .mocked(loadTargetReview)
    .mockResolvedValue({ heads: versions, revisions: versions });
  render(<TargetReviewPane {...props} />);
  await screen.findByText("Concurrent review versions");
  await user.type(
    screen.getByRole("textbox", { name: "Comparison review note" }),
    "combined",
  );
  await user.click(
    screen.getByRole("button", {
      name: "Save reconciliation of loaded versions",
    }),
  );
  await waitFor(() =>
    expect(saveTargetReview).toHaveBeenCalledWith(
      expect.objectContaining({
        parents: ["left", "right"],
        body: expect.objectContaining({ note: "combined" }),
      }),
    ),
  );
});

test("local recovery remains available when account review loading fails", async () => {
  const user = userEvent.setup();
  const first = render(<TargetReviewPane {...props} />);
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Comparison review note" }),
    ).toBeEnabled(),
  );
  await user.type(
    screen.getByRole("textbox", { name: "Comparison review note" }),
    "retained offline",
  );
  first.unmount();
  jest.mocked(loadTargetReview).mockRejectedValue(Error("offline"));
  render(<TargetReviewPane {...props} />);
  await screen.findByText("Error: offline");
  await user.click(
    screen.getByRole("button", { name: "Recover local draft 1" }),
  );
  expect(
    screen.getByRole("textbox", { name: "Comparison review note" }),
  ).toHaveValue("retained offline");
});

test("comparison search has keyboard focus and navigates filename and line matches", async () => {
  const user = userEvent.setup();
  render(<TargetReviewPane {...props} />);
  const note = await screen.findByRole("textbox", {
    name: "Comparison review note",
  });
  note.focus();
  await user.keyboard("{Control>}f{/Control}");
  const search = screen.getByRole("textbox", { name: "Search loaded diff" });
  expect(search).toHaveFocus();
  await user.type(search, "needle");
  expect(mockViewerProps.activeDiffFindMatch.kind).toBe("file");
  expect(screen.getByText("1 of 3 matches")).toBeInTheDocument();
  expect(mockViewerProps.diffFindMatchCounts.get(0)).toBe(3);
  expect(mockViewerProps.diffFindMatchedLineIndexes.get(0)).toEqual(
    new Set([1, 2]),
  );
  await user.keyboard("{Enter}");
  expect(mockViewerProps.activeDiffFindMatch.lineIndex).toBe(1);
  await user.keyboard("{Shift>}{Enter}{/Shift}");
  expect(mockViewerProps.activeDiffFindMatch.kind).toBe("file");
});

test("archive import targets this comparison and is disabled while editing", async () => {
  const user = userEvent.setup();
  render(<TargetReviewPane {...props} />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Import review archive" }),
    ).toBeEnabled(),
  );
  const file = new File(["{}"], "review.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => "{}" });
  await user.upload(screen.getByLabelText("Review archive file"), file);
  await waitFor(() =>
    expect(importTargetReview).toHaveBeenCalledWith({
      accountId: "a",
      target,
      payload: {},
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Comparison review note" }),
    ).toBeEnabled(),
  );
  await user.type(
    screen.getByRole("textbox", { name: "Comparison review note" }),
    "unsaved",
  );
  expect(
    screen.getByRole("button", { name: "Import review archive" }),
  ).toBeDisabled();
});

test("export includes all saved revisions, not just the visible head", async () => {
  const user = userEvent.setup();
  const revisions = ["old", "new"].map((id) => ({
    version: 1 as const,
    accountId: "a",
    target,
    id,
    parents: id === "new" ? ["old"] : [],
    updatedAt: 1,
    body: { reviewed: false, note: id, comments: {} },
  }));
  jest
    .mocked(loadTargetReview)
    .mockResolvedValue({ revisions, heads: [revisions[1]] });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: jest.fn(() => "blob:test"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: jest.fn(),
  });
  const click = jest
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  render(<TargetReviewPane {...props} />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Export saved versions" }),
    ).toBeEnabled(),
  );
  await user.click(
    screen.getByRole("button", { name: "Export saved versions" }),
  );
  await waitFor(() =>
    expect(exportTargetReview).toHaveBeenCalledWith(revisions),
  );
  expect(click).toHaveBeenCalledTimes(1);
  click.mockRestore();
});
