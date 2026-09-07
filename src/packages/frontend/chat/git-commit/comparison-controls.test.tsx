import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComparisonControls } from "./comparison-controls";
import { projectGitReader } from "@cocalc/frontend/git/project-read-service";

jest.mock("@cocalc/frontend/git/project-read-service", () => ({
  projectGitReader: {
    invalidateDiscovery: jest.fn(),
    discover: jest.fn(),
    compare: jest.fn(),
    pinCommit: jest.fn(),
  },
}));
const repository = {
  projectId: "p",
  locator: "/repo",
  commonDirectory: "/repo/.git",
  objectFormat: "sha1" as const,
};
test("requires explicit base and pins the requested mode on keyboard activation", async () => {
  const user = userEvent.setup();
  jest
    .mocked(projectGitReader.discover)
    .mockResolvedValue({ repository } as any);
  jest
    .mocked(projectGitReader.compare)
    .mockResolvedValue({ kind: "comparison" } as any);
  const apply = jest.fn();
  render(
    <ComparisonControls
      repository={repository}
      commit="HEAD"
      disabled={false}
      onApply={apply}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Compare / Refresh" }),
  ).toBeDisabled();
  await user.type(screen.getByRole("textbox", { name: "Base ref" }), "release");
  screen.getByRole("button", { name: "Compare / Refresh" }).focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(apply).toHaveBeenCalled());
  expect(projectGitReader.compare).toHaveBeenCalledWith(
    repository,
    "release",
    "HEAD",
    "merge-base",
  );
});

test("parent UI uses human numbering and rejects late results while editing", async () => {
  const user = userEvent.setup();
  let finish!: (target: any) => void;
  jest
    .mocked(projectGitReader.discover)
    .mockResolvedValue({ repository } as any);
  jest.mocked(projectGitReader.pinCommit).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const apply = jest.fn();
  const { rerender } = render(
    <ComparisonControls
      repository={repository}
      commit="HEAD"
      disabled={false}
      onApply={apply}
    />,
  );
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Comparison" }),
    "parent",
  );
  await user.click(screen.getByRole("button", { name: "Compare / Refresh" }));
  await waitFor(() =>
    expect(projectGitReader.pinCommit).toHaveBeenCalledWith(
      repository,
      "HEAD",
      0,
    ),
  );
  rerender(
    <ComparisonControls
      repository={repository}
      commit="HEAD"
      disabled
      onApply={apply}
    />,
  );
  finish({ kind: "commit" });
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Head ref" })).toBeDisabled(),
  );
  expect(apply).not.toHaveBeenCalled();
});
