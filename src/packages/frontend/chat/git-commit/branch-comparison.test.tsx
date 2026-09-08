import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BranchComparison } from "./branch-comparison";
import { projectGitReader } from "@cocalc/frontend/git/project-read-service";

jest.mock("@cocalc/frontend/git/project-read-service", () => ({
  projectGitReader: {
    discover: jest.fn(),
    resolveCommit: jest.fn(),
    history: jest.fn(),
    compare: jest.fn(),
  },
}));
const repository = {
  projectId: "p",
  locator: "/repo",
  commonDirectory: "/repo/.git",
  objectFormat: "sha1" as const,
};
const rows = ["a", "b"].map((c, i) => ({
  commit: c.repeat(40),
  subject: i ? "Before implementation" : "After implementation",
  parents: [],
  timestamp: 1,
}));
beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(projectGitReader.discover).mockResolvedValue({
    repository,
    refs: [{ name: "refs/heads/feature", object: "a".repeat(40) }],
    worktrees: [],
  });
  jest.mocked(projectGitReader.resolveCommit).mockResolvedValue("a".repeat(40));
  jest.mocked(projectGitReader.history).mockResolvedValue(rows);
});
async function select(name: string, text: string) {
  const user = userEvent.setup();
  await user.type(screen.getByRole("combobox", { name }), text);
  fireEvent.keyDown(screen.getByRole("combobox", { name }), {
    key: "Enter",
    keyCode: 13,
    which: 13,
  });
}
test("branch without a checkout supplies searchable commits and exact tree endpoints", async () => {
  const apply = jest.fn();
  jest
    .mocked(projectGitReader.compare)
    .mockResolvedValue({ kind: "comparison" } as any);
  render(
    <BranchComparison
      repository={repository}
      disabled={false}
      onApply={apply}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("2 commits loaded"),
  );
  await select("Comparison branch", "feature");
  await waitFor(() =>
    expect(projectGitReader.resolveCommit).toHaveBeenCalledWith(
      repository,
      "refs/heads/feature",
    ),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Before commit" }),
    ).toBeEnabled(),
  );
  await select("Before commit", "Before implementation");
  await select("After commit", "After implementation");
  const button = screen.getByRole("button", { name: "Compare commits" });
  button.focus();
  await userEvent.setup().keyboard("{Enter}");
  await waitFor(() => expect(apply).toHaveBeenCalled());
  expect(projectGitReader.compare).toHaveBeenCalledWith(
    repository,
    "b".repeat(40),
    "a".repeat(40),
    "trees",
  );
});
test("late branch history is discarded after the component unmounts", async () => {
  let finish!: (value: typeof rows) => void;
  jest.mocked(projectGitReader.history).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const apply = jest.fn();
  const view = render(
    <BranchComparison
      repository={repository}
      disabled={false}
      onApply={apply}
    />,
  );
  await waitFor(() => expect(projectGitReader.history).toHaveBeenCalled());
  view.unmount();
  finish(rows);
  expect(apply).not.toHaveBeenCalled();
});

test("editing locks preserve history and endpoints but invalidate pending comparisons", async () => {
  let finish!: (value: any) => void;
  jest.mocked(projectGitReader.compare).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const apply = jest.fn();
  const view = render(
    <BranchComparison
      repository={repository}
      disabled={false}
      onApply={apply}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("2 commits loaded"),
  );
  await select("Before commit", "Before implementation");
  await select("After commit", "After implementation");
  fireEvent.click(screen.getByRole("button", { name: "Compare commits" }));
  await waitFor(() =>
    expect(projectGitReader.compare).toHaveBeenCalledTimes(1),
  );
  view.rerender(
    <BranchComparison repository={repository} disabled onApply={apply} />,
  );
  view.rerender(
    <BranchComparison
      repository={repository}
      disabled={false}
      onApply={apply}
    />,
  );
  finish({ kind: "comparison" });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Compare commits" }),
    ).toBeEnabled(),
  );
  expect(apply).not.toHaveBeenCalled();
  expect(projectGitReader.history).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("combobox", { name: "Before commit" }).parentElement,
  ).toHaveTextContent("Before implementation");
  expect(
    screen.getByRole("combobox", { name: "After commit" }).parentElement,
  ).toHaveTextContent("After implementation");
});
