/*
 * This file is part of CoCalc: Copyright (c) 2026 SageMath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import React from "react";
import { act, render, screen } from "@testing-library/react";
import { fromJS, Map } from "immutable";

const mockActions = new globalThis.Map<string, any>();
const mockStores = new globalThis.Map<string, any>();
const mockRedux = {
  getActions: jest.fn((name) => mockActions.get(name)),
  createStore: jest.fn((name) => {
    const store = { state: {} };
    mockStores.set(name, store);
    return store;
  }),
  createActions: jest.fn((name, Actions) => {
    const actions = new Actions();
    actions.name = name;
    mockActions.set(name, actions);
    return actions;
  }),
  getStore: (name) => mockStores.get(name),
  removeActions: jest.fn((name) => mockActions.delete(name)),
  removeStore: jest.fn((name) => mockStores.delete(name)),
};

jest.mock("@cocalc/frontend/app-framework", () => ({
  ...jest.requireActual("react"),
  redux: mockRedux,
  redux_name: (projectId, path) => `${projectId}:${path}`,
}));
jest.mock("@cocalc/frontend/file-editors", () => ({
  register_file_editor: jest.fn(),
}));
jest.mock("@cocalc/frontend/components", () => ({
  Loading: () => <span>Loading</span>,
}));
jest.mock("@cocalc/frontend/i18n", () => ({
  isIntlMessage: () => false,
}));
jest.mock("../code-editor/editor", () => ({ cm: {} }));
jest.mock("../time-travel-editor/editor", () => ({
  Editor: () => null,
}));
jest.mock("@cocalc/frontend/frame-editors/time-travel-editor/actions", () => ({
  TimeTravelActions: class {
    _init = jest.fn();
    init_frame_tree = jest.fn();
    close = jest.fn();
  },
}));
// The suite's mapper redirects the frame-tree import, but not register.ts's
// local dynamic import. Both must see the same mocked actions class.
jest.mock("../time-travel-editor/actions", () =>
  jest.requireMock("@cocalc/frontend/frame-editors/time-travel-editor/actions"),
);
jest.mock("./frame-leaf-container", () => ({
  FrameLeafContainer: ({ leaf }) => leaf,
}));
jest.mock("./frame-tree-drag-bar", () => ({ FrameTreeDragBar: () => null }));
jest.mock("./tabs-container", () => ({ TabsContainer: () => null }));
jest.mock("./title-bar", () => ({ FrameTitleBar: () => null }));
const mockLeaf = jest.fn();
jest.mock("./leaf", () => ({
  FrameTreeLeaf: (props) => {
    mockLeaf(props);
    return <div role="region" aria-label="TimeTravel history" />;
  },
}));

import "../time-travel-editor/register";
import { get_file_editor } from "./register";
import { FrameTree } from "./frame-tree";

function props() {
  return {
    actions: { isClosed: () => false, blur: jest.fn() },
    path: "test.py",
    project_id: "project-1",
    name: "parent-editor",
    value: "print(42)",
    frame_tree: fromJS({ id: "history", type: "time_travel" }),
    editor_spec: {
      time_travel: { type: "timetravel", component: () => null },
    },
    reload: Map(),
  } as any;
}

beforeEach(() => {
  mockActions.clear();
  mockStores.clear();
  jest.clearAllMocks();
});

afterEach(() => jest.restoreAllMocks());

test("embedded TimeTravel initializes through the real lazy registration once", async () => {
  const registration = get_file_editor("time-travel");
  expect(registration.init).toBeUndefined();
  const init = jest.spyOn(registration, "initAsync");
  const parent = props();
  const view = render(<FrameTree {...parent} />);

  expect(
    await screen.findByRole("region", { name: "TimeTravel history" }),
  ).toBeVisible();
  const history = parent.actions.timeTravelActions;
  expect(history.ambient_actions).toBe(parent.actions);
  expect(history.init_frame_tree).toHaveBeenCalledTimes(1);
  expect(mockLeaf.mock.lastCall[0]).toMatchObject({
    actions: history,
    name: "project-1:.test.py.time-travel",
    path: ".test.py.time-travel",
    is_subframe: true,
  });
  view.rerender(<FrameTree {...parent} resize={1} />);
  expect(init).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(history.close).toHaveBeenCalledTimes(1);
  expect(mockActions.size).toBe(0);
});

test("closing an embedded frame while loading releases its late initialization", async () => {
  const registration = get_file_editor("time-travel");
  const initialize = registration.initAsync;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  jest.spyOn(registration, "initAsync").mockImplementation(async (...args) => {
    await pending;
    return initialize(...args);
  });
  const parent = props();
  const view = render(<FrameTree {...parent} />);
  expect(
    screen.getByRole("status", { name: "Loading TimeTravel" }),
  ).toBeVisible();
  view.unmount();
  await act(async () => {
    release();
  });
  expect(parent.actions.timeTravelActions).toBeUndefined();
  expect(mockRedux.removeActions).toHaveBeenCalledTimes(1);
  expect(mockActions.size).toBe(0);
});

test("embedded history reports a failed lazy load without rendering an invalid leaf", async () => {
  jest
    .spyOn(get_file_editor("time-travel"), "initAsync")
    .mockRejectedValueOnce(new Error("chunk unavailable"));
  render(<FrameTree {...props()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "chunk unavailable",
  );
  expect(mockLeaf).not.toHaveBeenCalled();
});

test("closing an embedded frame preserves an independently opened history tab", async () => {
  const registration = get_file_editor("time-travel");
  const path = ".test.py.time-travel";
  const name = await registration.initAsync(path, mockRedux, "project-1");
  const history = mockActions.get(name);
  const view = render(<FrameTree {...props()} />);
  await screen.findByRole("region", { name: "TimeTravel history" });
  view.unmount();
  expect(history.close).not.toHaveBeenCalled();
  expect(mockActions.get(name)).toBe(history);
  registration.remove(path, mockRedux, "project-1");
  expect(history.close).toHaveBeenCalledTimes(1);
  expect(mockActions.size).toBe(0);
});

test("StrictMode effect replay leaves one live history reference", async () => {
  const parent = props();
  const view = render(
    <React.StrictMode>
      <FrameTree {...parent} />
    </React.StrictMode>,
  );
  await screen.findByRole("region", { name: "TimeTravel history" });
  const history = parent.actions.timeTravelActions;
  expect(history.close).not.toHaveBeenCalled();
  view.unmount();
  expect(history.close).toHaveBeenCalledTimes(1);
  expect(mockActions.size).toBe(0);
  expect(parent.actions.timeTravelActions).toBeUndefined();
});
