import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CommitArtifact, verifyArtifactCommit } from "./commit-artifact";
const exec = jest.fn();
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: { project_client: { exec: (...args) => exec(...args) } },
}));
jest.mock("@cocalc/frontend/chat/git-commit-drawer", () => ({
  GitCommitDrawer: (props) => (
    <div role="status">
      Review {props.commitHash} in {props.cwdOverride}
    </div>
  ),
}));
const commit = {
  sha: "a".repeat(40),
  path: "/repo/worktree",
  common_directory: "/repo/.git",
  branch: "topic",
};
beforeEach(() => {
  exec.mockReset();
  exec.mockImplementation(async ({ args }) => ({
    exit_code: 0,
    stdout: args[0] === "rev-parse" ? "/repo/.git\n" : "",
  }));
});
test("pins the SHA and worktree after keyboard-accessible review activation", async () => {
  render(
    <CommitArtifact
      artifact={{ title: "Fix", input: "Summary", commit } as any}
      projectId="project"
      sourcePath="/chat.chat"
    />,
  );
  const button = screen.getByRole("button", { name: "Review commit" });
  button.focus();
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain(commit.sha),
  );
  expect(exec).toHaveBeenLastCalledWith(
    expect.objectContaining({
      path: commit.path,
      bash: false,
      args: ["cat-file", "-e", `${commit.sha}^{commit}`],
    }),
  );
});
test("rejects a different repository without launching review", async () => {
  exec.mockResolvedValue({ exit_code: 0, stdout: "/other/.git" });
  await expect(verifyArtifactCommit("project", commit)).rejects.toThrow(
    /identity changed/,
  );
  expect(exec).toHaveBeenCalledTimes(1);
});
