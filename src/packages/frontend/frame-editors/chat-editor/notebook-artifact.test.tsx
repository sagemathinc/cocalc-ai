/** @jest-environment jsdom */
import { EventEmitter } from "events";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NotebookArtifact from "./notebook-artifact";

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
jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({ actions }),
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getEditorActions: () => ({ jupyter_actions: { syncdb } }),
  },
}));
jest.mock("@cocalc/frontend/keyboard/boundary", () => ({
  KeyboardBoundary: ({ children }) => <div>{children}</div>,
}));
jest.mock("@cocalc/frontend/jupyter/readonly-notebook", () => ({
  ReadonlyNotebook: ({ doc }) => <div>{doc.text}</div>,
}));

beforeEach(() => {
  jest.clearAllMocks();
  syncdb.removeAllListeners();
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
