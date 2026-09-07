import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TargetReviewPane } from "./target-review-pane";
import { loadTargetReview, saveTargetReview } from "../git-target-review-store";
import type { ImmutableReviewTarget } from "@cocalc/frontend/components/diff-viewer/review-model";

jest.mock("@cocalc/frontend/git/project-read-service", () => ({
  projectGitReader: {},
}));
jest.mock("@cocalc/frontend/git/read-target-diff", () => ({
  readTargetDiff: async () => ({ files: [], linesTruncated: false }),
}));
jest.mock("../git-target-review-store", () => ({
  loadTargetReview: jest.fn(),
  saveTargetReview: jest.fn(),
}));
jest.mock("./pierre-review-panel", () => ({
  __esModule: true,
  default: () => <div>Diff</div>,
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
beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
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
