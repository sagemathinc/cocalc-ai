import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { FileArtifact, fileArtifactPreviewSupported } from "./file-artifact";

const readFile = jest.fn();
const stat = jest.fn();
const open_file = jest.fn().mockResolvedValue(undefined);
const actions = { fs: () => ({ stat, readFile }), open_file };
let mockRole = "collaborator";
jest.mock("@cocalc/frontend/project/use-project-host-authed-url", () => ({
  useProjectHostAuthedUrl: ({ url }) => url,
}));
jest.mock("@cocalc/frontend/project/viewer-file-editor", () => ({
  viewerRawFileUrl: ({ project_id, path, viewer }) =>
    `/files/${project_id}/${path}${viewer ? "?viewer=1" : ""}`,
}));
jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({ actions, projectAccess: { role: mockRole } }),
}));
jest.mock("@cocalc/frontend/public-viewer/file-contents", () => ({
  __esModule: true,
  default: ({ content, fileContext, rawUrl, style }) => (
    <div
      data-testid="preview"
      data-sanitized={String(fileContext.noSanitize === false)}
      data-raw-url={rawUrl}
      style={style}
    >
      {content}
    </div>
  ),
}));
const artifact: any = {
  artifact_id: "policy",
  thread_id: "thread",
  kind: "file",
  title: "Policy",
  file: { path: "/home/user/policy.md" },
};

test("selected feedback pins original file contents across refresh", async () => {
  const onComment = jest.fn().mockResolvedValue(undefined);
  render(
    <FileArtifact
      artifact={artifact}
      historical={false}
      onComment={onComment}
    />,
  );
  const preview = await screen.findByTestId("preview");
  act(() => {
    const range = document.createRange();
    range.setStart(preview.firstChild!, 0);
    range.setEnd(preview.firstChild!, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  readFile.mockResolvedValue("New contents");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(preview).toHaveTextContent("New contents"));
  fireEvent.click(screen.getByRole("button", { name: "Comment" }));
  expect(onComment).toHaveBeenCalledWith(
    expect.objectContaining({
      file: artifact.file,
      markdown: "Saved policy",
      quote: "Saved",
      thread_id: "thread",
    }),
  );
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRole = "collaborator";
  stat.mockResolvedValue({ size: 10 });
  readFile.mockResolvedValue("Saved policy");
});

test("previews saved text, opens the real file, and keeps the preview mounted on refresh", async () => {
  render(<FileArtifact artifact={artifact} historical />);
  const preview = await screen.findByTestId("preview");
  expect(preview).toHaveTextContent("Saved policy");
  expect(preview.dataset.sanitized).toBe("true");
  expect(screen.getByRole("note")).toHaveTextContent(
    "not a historical snapshot",
  );
  const open = screen.getByRole("button", { name: "Open file" });
  open.focus();
  expect(document.activeElement).toBe(open);
  fireEvent.click(open);
  expect(open_file).toHaveBeenCalledWith({ path: artifact.file.path });
  readFile.mockResolvedValue("Updated policy");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(preview).toHaveTextContent("Updated policy"));
  expect(screen.getByTestId("preview")).toBe(preview);
});

test("does not fetch unsupported active formats or oversized files", async () => {
  const { rerender } = render(
    <FileArtifact
      artifact={{ ...artifact, file: { path: "app.html" } }}
      historical={false}
    />,
  );
  expect(screen.getByText(/Preview is not yet supported/)).toBeTruthy();
  expect(readFile).not.toHaveBeenCalled();
  stat.mockResolvedValue({ size: 2 * 1024 * 1024 });
  rerender(<FileArtifact artifact={artifact} historical={false} />);
  await screen.findByText(/File exceeds the 1 MiB preview limit/);
  expect(readFile).not.toHaveBeenCalled();
});

test.each(["x.html", "x.svg", "x.ipynb"])(
  "does not select active renderer for %s",
  (path) => {
    expect(fileArtifactPreviewSupported(path)).toBe(false);
  },
);

test.each(["plot.png", "report.pdf"])(
  "supports binary %s without reading as text",
  (path) => {
    render(
      <FileArtifact
        artifact={{ ...artifact, file: { path } }}
        historical={false}
        projectId="project"
      />,
    );
    expect(fileArtifactPreviewSupported(path)).toBe(true);
    expect(readFile).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Comment" })).toBeDisabled();
    expect(screen.getByTestId("preview")).toHaveStyle({
      height: path.endsWith(".pdf") ? "100%" : "auto",
    });
    if (path.endsWith(".png"))
      expect(screen.getByTestId("preview")).toHaveStyle({
        width: "auto",
        maxHeight: "100%",
        objectFit: "contain",
      });
  },
);

test("viewer binary URLs preserve read-only routing during refresh and file changes", () => {
  mockRole = "viewer";
  const { rerender } = render(
    <FileArtifact
      artifact={{ ...artifact, file: { path: "plot.png" } }}
      historical
      projectId="project"
    />,
  );
  expect(screen.getByTestId("preview")).toHaveAttribute(
    "data-raw-url",
    "/files/project/plot.png?viewer=1&artifactRefresh=0",
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(screen.getByTestId("preview")).toHaveAttribute(
    "data-raw-url",
    "/files/project/plot.png?viewer=1&artifactRefresh=1",
  );
  rerender(
    <FileArtifact
      artifact={{ ...artifact, file: { path: "report.pdf" } }}
      historical
      projectId="project"
    />,
  );
  expect(screen.getByTestId("preview")).toHaveAttribute(
    "data-raw-url",
    "/files/project/report.pdf?viewer=1&artifactRefresh=1",
  );
  expect(readFile).not.toHaveBeenCalled();
});

test("binary preview requires project identity rather than using another project's URL", () => {
  render(
    <FileArtifact
      artifact={{ ...artifact, file: { path: "plot.png" } }}
      historical
    />,
  );
  expect(screen.getByText(/Project identity is unavailable/)).toBeTruthy();
  expect(screen.queryByTestId("preview")).toBeNull();
});

test("failed refresh retains previous text and clearly marks it stale", async () => {
  render(<FileArtifact artifact={artifact} historical={false} />);
  const preview = await screen.findByTestId("preview");
  readFile.mockRejectedValueOnce(Error("File was removed"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Error: File was removed");
  expect(
    screen.getByText(/previous preview is retained and may be stale/),
  ).toBeTruthy();
  expect(screen.getByTestId("preview")).toBe(preview);
  expect(preview).toHaveTextContent("Saved policy");
});

test("large readable files explain why snapshot feedback is unavailable", async () => {
  readFile.mockResolvedValue("x".repeat(33 * 1024));
  render(
    <FileArtifact
      artifact={artifact}
      historical={false}
      onComment={jest.fn()}
    />,
  );
  await screen.findByTestId("preview");
  expect(screen.getByText(/snapshot of at most 32 KiB/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Comment" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Open file" })).toBeEnabled();
});

test("missing initial file shows the error without displaying another path's preview", async () => {
  const { rerender } = render(
    <FileArtifact artifact={artifact} historical={false} />,
  );
  await screen.findByTestId("preview");
  stat.mockRejectedValueOnce(Error("No such file"));
  rerender(
    <FileArtifact
      artifact={{ ...artifact, file: { path: "/missing.md" } }}
      historical={false}
    />,
  );
  await screen.findByText("Error: No such file");
  expect(screen.queryByTestId("preview")).toBeNull();
  expect(screen.queryByText(/previous preview is retained/)).toBeNull();
});
