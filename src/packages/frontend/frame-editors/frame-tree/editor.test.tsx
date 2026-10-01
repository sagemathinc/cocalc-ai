/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";
import { Map, Set } from "immutable";
import { createEditor } from "./editor";

const mockUseRedux = jest.fn();
const mockUseTypedRedux = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => {
  const React = require("react");
  return {
    React,
    project_redux_name: (project_id: string) => `project-${project_id}`,
    useEffect: React.useEffect,
    useRedux: (...args: any[]) => mockUseRedux(...args),
    useRef: React.useRef,
    useTypedRedux: (...args: any[]) => mockUseTypedRedux(...args),
  };
});

jest.mock("@cocalc/frontend/components", () => ({
  ErrorDisplay: ({ error, onClose }: any) => (
    <div role="alert">
      {error}
      {onClose ? (
        <button type="button" onClick={onClose}>
          close
        </button>
      ) : null}
    </div>
  ),
  Loading: () => <div>Loading...</div>,
}));

jest.mock("@cocalc/frontend/chat/paths", () => ({
  isChatPath: () => false,
}));

jest.mock("@cocalc/frontend/project/workspaces/editor-theme", () => ({
  effectiveImmutableEditorSettings: (settings: any) => settings,
}));

jest.mock("@cocalc/frontend/project/workspaces/use-workspace-record", () => ({
  useWorkspaceRecordForPath: () => null,
}));

jest.mock("./dnd/frame-dnd-provider", () => ({
  FrameDndProvider: ({ children }: any) => <div>{children}</div>,
}));

jest.mock("./format-error", () => () => null);
const mockFrameTree = jest.fn();
jest.mock("./frame-tree", () => ({
  FrameTree: (props: any) => {
    mockFrameTree(props);
    return <div>frame tree</div>;
  },
}));
jest.mock("./status-bar", () => () => null);

const baseState = {
  available_features: undefined,
  complete: Map(),
  cursors: Map(),
  derived_file_types: Set(),
  editor_settings: undefined,
  error: "",
  errorstyle: undefined,
  formatError: undefined,
  formatInput: undefined,
  gutter_markers: Map(),
  has_uncommitted_changes: false,
  has_unsaved_changes: false,
  is_loaded: false,
  is_saving: false,
  load_time_estimate: undefined,
  local_view_state: Map({
    active_id: "cm",
    editor_state: Map(),
    font_size: 12,
    frame_tree: Map({ id: "cm", type: "cm" }),
  }),
  misspelled_words: Set(),
  read_only: false,
  reload: Map(),
  resize: 0,
  settings: Map(),
  status: "",
  terminal: undefined,
  value: "Loading...",
  visible: true,
};

function renderEditor(
  state: Partial<typeof baseState>,
  { isVisible = true }: { isVisible?: boolean } = {},
) {
  const mergedState = { ...baseState, ...state };
  mockUseRedux.mockImplementation((_name: string, key: string) => {
    return mergedState[key as keyof typeof mergedState];
  });
  mockUseTypedRedux.mockImplementation(() => undefined);
  const Editor = createEditor({
    display_name: "TestEditor",
    editor_spec: {},
  });

  return render(
    <Editor
      actions={{ set_error: jest.fn(), set_resize: jest.fn() }}
      name="editor"
      path="test.md"
      project_id="project-1"
      is_visible={isVisible}
    />,
  );
}

describe("FrameTreeEditor loading state", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows an initial load error instead of keeping the editor spinner visible", () => {
    renderEditor({
      error: "syncdoc failed before ready",
      is_loaded: false,
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "syncdoc failed before ready",
    );
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });
});

describe("FrameTreeEditor frame visibility", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const loaded = { is_loaded: true, value: "" };
  const framesVisible = () =>
    mockFrameTree.mock.calls[mockFrameTree.mock.calls.length - 1][0].is_visible;

  it("shows frames on a visible surface even after the project hid the file", () => {
    // The project page hid its tab for this file (visible: false), but the
    // same editor is shown elsewhere, e.g. in the Agents workspace.
    renderEditor({ ...loaded, visible: false }, { isVisible: true });
    expect(framesVisible()).toBe(true);
  });

  it("keeps the shared visibility for a surface that is not shown", () => {
    renderEditor({ ...loaded, visible: false }, { isVisible: false });
    expect(framesVisible()).toBe(false);
    renderEditor({ ...loaded, visible: true }, { isVisible: false });
    expect(framesVisible()).toBe(true);
  });
});
