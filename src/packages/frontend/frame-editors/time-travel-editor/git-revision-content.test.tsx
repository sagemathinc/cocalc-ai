import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GitRevisionContent from "./git-revision-content";
import { loadGitHistoricalFile } from "@cocalc/frontend/git/historical-file";

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => ({}),
}));
jest.mock("@cocalc/frontend/git/project-read-service", () => ({
  projectGitReader: {},
}));
jest.mock("@cocalc/frontend/git/historical-file", () => ({
  loadGitHistoricalFile: jest.fn(),
}));
jest.mock("@cocalc/frontend/lib/file-context", () => ({
  FileContext: require("react").createContext({}),
  useFileContext: () => ({}),
}));
jest.mock("./viewer", () => ({
  HAS_SPECIAL_VIEWER: new Set(["md"]),
  Viewer: ({ doc }) => <div data-testid="rich-revision">{doc().to_str()}</div>,
}));
jest.mock("./document", () => ({
  TextDocument: ({ value, sourcePosition }) => (
    <div data-testid="source-revision">
      {value}
      <span data-testid="position">{sourcePosition?.line}</span>
    </div>
  ),
}));
jest.mock("./view-document", () => ({
  ViewDocument: class {
    constructor(
      private textPath,
      private text,
    ) {}
    to_str() {
      return this.text;
    }
  },
}));

const request = {
  projectId: "project",
  cwd: "/repo",
  commit: "a".repeat(40),
  path: "file.md",
};
const file = {
  contents: "# Old heading\nold source\n",
  blob: "b".repeat(40),
  mode: "100644",
  source: {
    kind: "git" as const,
    commit: request.commit,
    path: request.path,
    repository: {
      projectId: "project",
      commonDirectory: "/repo/.git",
      locator: "/repo",
      objectFormat: "sha1" as const,
    },
  },
};
const load = jest.mocked(loadGitHistoricalFile);
beforeEach(() => load.mockReset());

test("reuses the rich historical document viewer and jumps into original read-only source", async () => {
  load.mockResolvedValue(file);
  const user = userEvent.setup();
  render(<GitRevisionContent request={request} fontSize={14} />);
  expect(await screen.findByTestId("rich-revision")).toHaveTextContent(
    "Old heading",
  );
  expect(screen.getByText(request.commit)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Source text" }));
  expect(screen.getByTestId("source-revision")).toHaveTextContent("old source");
  const input = screen.getByRole("spinbutton", {
    name: "Historical source line",
  });
  await user.clear(input);
  await user.type(input, "2");
  await user.click(screen.getByRole("button", { name: "Go to source line" }));
  expect(screen.getByTestId("position")).toHaveTextContent("2");
  await user.clear(input);
  await user.type(input, "999");
  await user.click(screen.getByRole("button", { name: "Go to source line" }));
  expect(screen.getByText("This revision has 3 source lines.")).toBeVisible();
  expect(screen.getByTestId("position")).toHaveTextContent("2");
});

test("ignores late successes and errors after changing historical targets", async () => {
  let resolveFirst!: (value: typeof file) => void;
  load.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );
  load.mockRejectedValueOnce(new Error("Missing exact revision"));
  const { rerender } = render(
    <GitRevisionContent request={request} fontSize={14} />,
  );
  const next = { ...request, commit: "c".repeat(40) };
  rerender(<GitRevisionContent request={next} fontSize={14} />);
  await screen.findByText("Error: Missing exact revision");
  await act(async () => resolveFirst(file));
  expect(screen.queryByTestId("rich-revision")).toBeNull();
  expect(load).toHaveBeenCalledTimes(2);
});

test("a late failed request cannot replace a successfully loaded newer file", async () => {
  let rejectFirst!: (error: Error) => void;
  load.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }),
  );
  load.mockResolvedValueOnce(file);
  const { rerender, unmount } = render(
    <GitRevisionContent request={request} fontSize={14} />,
  );
  rerender(<GitRevisionContent request={{ ...request }} fontSize={14} />);
  await screen.findByTestId("rich-revision");
  await act(async () => rejectFirst(new Error("Late error")));
  await waitFor(() =>
    expect(screen.queryByText("Error: Late error")).toBeNull(),
  );
  unmount();
});
