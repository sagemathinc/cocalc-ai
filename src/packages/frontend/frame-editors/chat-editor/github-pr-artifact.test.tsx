import { fireEvent, render, screen } from "@testing-library/react";
import { GitHubPRArtifact } from "./github-pr-artifact";
import {
  verifyPRCommits,
  refreshPR,
  fetchPRCommits,
} from "./github-pr-operations";
jest.mock("./github-pr-operations", () => ({
  verifyPRCommits: jest.fn(),
  refreshPR: jest.fn(),
  fetchPRCommits: jest.fn(),
}));
jest.mock("@cocalc/frontend/chat/git-commit-drawer", () => ({
  GitCommitDrawer: (props) => (
    <div data-testid="review">{JSON.stringify(props.initialComparison)}</div>
  ),
}));
jest.mock("@cocalc/frontend/editors/slate/static-markdown", () => ({
  __esModule: true,
  default: ({ value }) => <div>{value}</div>,
}));
const pr = {
  repository: "sagemathinc/cocalc-ai",
  number: 509,
  state: "open",
  draft: true,
  fetched_at: "2026-09-10T00:00:00Z",
  checks: "pending",
  base_sha: "a".repeat(40),
  head_sha: "b".repeat(40),
  local: { path: "/repo", common_directory: "/repo/.git" },
};
const artifact: any = {
  title: "Workbench",
  input: "PR description",
  github_pr: pr,
};
beforeEach(() => {
  jest.clearAllMocks();
  (verifyPRCommits as jest.Mock).mockResolvedValue(pr);
});
test("opens an explicit comparison and keeps it pinned across metadata refresh", async () => {
  const { rerender } = render(
    <GitHubPRArtifact
      artifact={artifact}
      projectId="p"
      sourcePath="x.chat"
      historical={false}
    />,
  );
  expect(screen.getByRole("link", { name: "GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/sagemathinc/cocalc-ai/pull/509",
  );
  const button = screen.getByRole("button", { name: "Review locally" });
  button.focus();
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  expect(await screen.findByTestId("review")).toHaveTextContent(pr.head_sha);
  rerender(
    <GitHubPRArtifact
      artifact={{ ...artifact, github_pr: { ...pr, head_sha: "c".repeat(40) } }}
      projectId="p"
      sourcePath="x.chat"
      historical={false}
    />,
  );
  expect(screen.getByTestId("review")).toHaveTextContent(pr.head_sha);
  expect(screen.getByTestId("review")).not.toHaveTextContent("c".repeat(40));
});
test("missing local repository leaves external browsing available", () => {
  render(
    <GitHubPRArtifact
      artifact={{ ...artifact, github_pr: { ...pr, local: undefined } }}
      projectId="p"
      sourcePath="x.chat"
      historical
    />,
  );
  expect(screen.getByRole("button", { name: "Review locally" })).toBeDisabled();
  expect(screen.getByRole("note")).toHaveTextContent("Published metadata");
});

test("repository mismatch never opens a misleading local review", async () => {
  (verifyPRCommits as jest.Mock).mockRejectedValue(
    Error("No fetch remote matches"),
  );
  render(
    <GitHubPRArtifact
      artifact={artifact}
      projectId="p"
      sourcePath="x.chat"
      historical={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Review locally" }));
  expect(await screen.findByText(/No fetch remote matches/)).toBeTruthy();
  expect(screen.queryByTestId("review")).toBeNull();
  expect(fetchPRCommits).not.toHaveBeenCalled();
});

test("refresh is explicit and saves against the exact observed artifact", async () => {
  const next = {
    title: "Updated",
    input: "Body",
    github_pr: { ...pr, head_sha: "c".repeat(40) },
  };
  (refreshPR as jest.Mock).mockResolvedValue(next);
  const onRefresh = jest.fn().mockResolvedValue(undefined);
  render(
    <GitHubPRArtifact
      artifact={artifact}
      projectId="p"
      sourcePath="x.chat"
      historical={false}
      onRefresh={onRefresh}
    />,
  );
  expect(refreshPR).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText(/PR metadata refreshed/);
  expect(onRefresh).toHaveBeenCalledWith(next, artifact);
  expect(fetchPRCommits).not.toHaveBeenCalled();
});
