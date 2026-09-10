import { fireEvent, render, screen } from "@testing-library/react";
import { GitHubPRArtifact } from "./github-pr-artifact";
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
