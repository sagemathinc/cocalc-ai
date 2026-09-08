import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComparisonModal } from "./comparison-modal";
import { projectGitReader } from "@cocalc/frontend/git/project-read-service";

jest.mock("@cocalc/frontend/git/project-read-service", () => ({
  projectGitReader: {
    invalidateDiscovery: jest.fn(),
    discover: jest.fn(),
    compare: jest.fn(),
    pinCommit: jest.fn(),
  },
}));
jest.mock("./target-review-pane", () => ({
  TargetReviewPane: ({ target }: any) => (
    <div role="status">Pinned {target.head}</div>
  ),
}));
const repository = {
  projectId: "p",
  locator: "/repo",
  commonDirectory: "/repo/.git",
  objectFormat: "sha1" as const,
};
const initialComparison = {
  commonDirectory: repository.commonDirectory,
  mode: "trees" as const,
  head: "a".repeat(40),
  base: "b".repeat(40),
};
const props = {
  repository,
  initialComparison,
  commit: "HEAD",
  accountId: "account",
  fontSize: 14,
  onClose: jest.fn(),
  onView: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  const getComputedStyle = window.getComputedStyle;
  jest
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element) => getComputedStyle(element));
});
afterEach(() => jest.restoreAllMocks());

test("restores pinned content and controls without a click and retains keyboard dismissal", async () => {
  const user = userEvent.setup();
  jest
    .mocked(projectGitReader.discover)
    .mockResolvedValue({ repository } as any);
  jest.mocked(projectGitReader.compare).mockResolvedValue({
    ...initialComparison,
    kind: "comparison",
    repository,
    requestedBase: initialComparison.base,
  });
  render(<ComparisonModal {...props} />);
  expect(
    await screen.findByText(`Pinned ${initialComparison.head}`),
  ).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Base ref" })).toHaveValue(
    initialComparison.base,
  );
  expect(screen.getByRole("textbox", { name: "Head ref" })).toHaveValue(
    initialComparison.head,
  );
  expect(screen.getByRole("combobox", { name: "Comparison" })).toHaveValue(
    "trees",
  );
  screen.getByRole("textbox", { name: "Head ref" }).focus();
  await user.keyboard("{Escape}");
  expect(props.onClose).toHaveBeenCalled();
});

test("failed restoration is explicit and allows a new comparison", async () => {
  jest
    .mocked(projectGitReader.discover)
    .mockRejectedValue(Error("Repository missing"));
  render(<ComparisonModal {...props} />);
  await waitFor(() =>
    expect(screen.getByText("Cannot restore comparison")).toBeVisible(),
  );
  expect(
    screen.queryByText(`Pinned ${initialComparison.head}`),
  ).not.toBeInTheDocument();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Compare / Refresh" }),
    ).toBeEnabled(),
  );
});
