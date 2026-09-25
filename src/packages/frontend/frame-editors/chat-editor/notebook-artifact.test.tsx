/** @jest-environment jsdom */
import { EventEmitter } from "events";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NotebookArtifact from "./notebook-artifact";
import { FileContext, useFileContext } from "@cocalc/frontend/lib/file-context";
import { fileURL } from "@cocalc/frontend/lib/cocalc-urls";

const stat = jest.fn();
const open_file = jest.fn();
const download_file = jest.fn();
const actions = { fs: () => ({ stat }), open_file, download_file };
let document = { text: "unsaved live contents" };
const syncdb = Object.assign(new EventEmitter(), {
  isReady: () => true,
  is_live_connected: jest.fn(() => true),
  get_doc: () => document,
  close: jest.fn(),
});
let mockSyncdb = syncdb;
jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({ actions }),
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getEditorActions: () => ({ jupyter_actions: { syncdb: mockSyncdb } }),
  },
}));
jest.mock("@cocalc/frontend/keyboard/boundary", () => ({
  KeyboardBoundary: ({ children }) => <div>{children}</div>,
}));
jest.mock("@cocalc/frontend/jupyter/readonly-notebook", () => ({
  ReadonlyNotebook: ({ doc }) => (
    <>
      <div>{doc.text}</div>
      <NotebookContextProbe />
    </>
  ),
}));
jest.mock("@cocalc/frontend/components/smart-anchor-tag", () => ({
  __esModule: true,
  default: ({ project_id, path, href, children }) => (
    <a href={href} data-project-id={project_id} data-source-path={path}>
      {children}
    </a>
  ),
}));

function NotebookContextProbe() {
  const file = useFileContext();
  const Anchor = file.AnchorTagComponent;
  return (
    <>
      <span>
        {file.project_id}:{file.path}
      </span>
      <span>
        {file.anchorTagAction ? "chat navigation" : "file navigation"}
      </span>
      <img alt="Notebook plot" src={file.urlTransform?.("plot.png", "img")} />
      {Anchor && <Anchor href="data.csv">Notebook data</Anchor>}
    </>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  syncdb.removeAllListeners();
  syncdb.is_live_connected.mockReturnValue(true);
  mockSyncdb = syncdb;
  stat.mockResolvedValue({ size: 100 });
  open_file.mockResolvedValue(undefined);
  download_file.mockResolvedValue(undefined);
  document = { text: "unsaved live contents" };
});

test("observes the project-owned notebook and detaches without closing it", async () => {
  const view = render(<NotebookArtifact projectId="p" path="analysis.ipynb" />);
  expect(await screen.findByText("unsaved live contents")).toBeTruthy();
  expect(open_file).toHaveBeenCalledWith(
    expect.objectContaining({
      embedded: true,
      foreground: false,
      foreground_project: false,
      change_history: false,
    }),
  );
  act(() => {
    document = { text: "another live edit" };
    syncdb.emit("change");
  });
  expect(screen.getByText("another live edit")).toBeTruthy();
  view.unmount();
  expect(syncdb.listenerCount("change")).toBe(0);
  expect(syncdb.close).not.toHaveBeenCalled();
});

test("a missing file is reported without creating a notebook", async () => {
  stat.mockRejectedValueOnce(new Error("Notebook not found"));
  render(<NotebookArtifact projectId="p" path="missing.ipynb" />);
  expect(await screen.findByText(/Notebook not found/)).toBeTruthy();
  expect(open_file).not.toHaveBeenCalled();
});

test("notebook resources use its file context instead of the conversation's", async () => {
  const parentTransform = jest.fn(() => "wrong-chat-image.png");
  render(
    <FileContext.Provider
      value={{
        project_id: "destination",
        path: "chats/session.chat",
        urlTransform: parentTransform,
        anchorTagAction: jest.fn(),
        AnchorTagComponent: () => <a href="wrong-chat-link">Chat link</a>,
      }}
    >
      <NotebookArtifact projectId="source" path="notebooks/report.ipynb" />
    </FileContext.Provider>,
  );
  await screen.findByText("unsaved live contents");
  expect(screen.getByText("source:notebooks/report.ipynb")).toBeTruthy();
  expect(screen.getByText("file navigation")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Notebook plot" })).toHaveAttribute(
    "src",
    fileURL({ project_id: "source", path: "notebooks/plot.png" }),
  );
  const link = screen.getByRole("link", { name: "Notebook data" });
  expect(link).toHaveAttribute("data-project-id", "source");
  expect(link).toHaveAttribute("data-source-path", "notebooks/report.ipynb");
  expect(link).toHaveAttribute("href", "data.csv");
  expect(parentTransform).not.toHaveBeenCalled();
});

test("failed reconnect retains contents and observes automatic recovery", async () => {
  const view = render(<NotebookArtifact projectId="p" path="analysis.ipynb" />);
  await screen.findByText("unsaved live contents");
  act(() => {
    syncdb.is_live_connected.mockReturnValue(false);
    syncdb.emit("disconnected");
  });
  stat.mockRejectedValueOnce(Error("Offline"));
  const button = screen.getByRole("button", { name: "Reconnect" });
  button.focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByText(/Offline/);
  expect(button).toHaveFocus();
  expect(screen.getByText("unsaved live contents")).toBeTruthy();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Disconnected: last received contents",
  );
  expect(syncdb.listenerCount("connected")).toBe(1);
  act(() => {
    document = { text: "recovered contents" };
    syncdb.is_live_connected.mockReturnValue(true);
    syncdb.emit("connected");
  });
  expect(screen.getByText("recovered contents")).toBeTruthy();
  expect(screen.getByRole("status")).toHaveTextContent("Live notebook");
  expect(screen.queryByText(/Offline/)).toBeNull();
  view.unmount();
  expect(syncdb.listenerCount("connected")).toBe(0);
  expect(syncdb.close).not.toHaveBeenCalled();
});

test("successful retry replaces the observer without closing either runtime", async () => {
  const view = render(<NotebookArtifact projectId="p" path="analysis.ipynb" />);
  await screen.findByText("unsaved live contents");
  const replacement = Object.assign(new EventEmitter(), {
    isReady: () => true,
    is_live_connected: jest.fn(() => true),
    get_doc: () => ({ text: "replacement contents" }),
    close: jest.fn(),
  });
  mockSyncdb = replacement;
  await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
  await screen.findByText("replacement contents");
  expect(syncdb.listenerCount("change")).toBe(0);
  expect(replacement.listenerCount("change")).toBe(1);
  act(() => syncdb.emit("change"));
  expect(screen.queryByText("unsaved live contents")).toBeNull();
  view.unmount();
  expect(replacement.listenerCount("change")).toBe(0);
  expect(syncdb.close).not.toHaveBeenCalled();
  expect(replacement.close).not.toHaveBeenCalled();
});

test("switching notebook identity clears old contents even if the new load fails", async () => {
  const view = render(<NotebookArtifact projectId="p" path="analysis.ipynb" />);
  await screen.findByText("unsaved live contents");
  stat.mockRejectedValueOnce(Error("Missing replacement"));
  view.rerender(<NotebookArtifact projectId="other" path="missing.ipynb" />);
  await screen.findByText(/Missing replacement/);
  expect(screen.queryByText("unsaved live contents")).toBeNull();
  expect(syncdb.listenerCount("change")).toBe(0);
});

test("reconnect is keyboard accessible and preserves focus", async () => {
  render(<NotebookArtifact projectId="p" path="analysis.ipynb" />);
  await screen.findByText("unsaved live contents");
  const button = screen.getByRole("button", { name: "Reconnect" });
  button.focus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(open_file).toHaveBeenCalledTimes(2));
  expect(button).toHaveFocus();
  expect(syncdb.listenerCount("change")).toBe(1);
});
