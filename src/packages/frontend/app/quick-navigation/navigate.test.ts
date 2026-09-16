/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("@cocalc/frontend/app-framework", () => ({ redux: {} }));
jest.mock("@cocalc/frontend/logger", () => ({
  getLogger: () => ({ debug: jest.fn() }),
}));
jest.mock("@cocalc/frontend/account/settings-routing", () => ({
  openAccountSettings: jest.fn(),
}));
jest.mock("@cocalc/frontend/docs/navigation", () => ({
  openAppDocs: jest.fn(),
  openProjectDocs: jest.fn(),
}));
jest.mock("@cocalc/frontend/project/page/file-tab", () => ({
  FIXED_PROJECT_TABS: {},
}));
jest.mock("@cocalc/frontend/project/page/activate-project-tab", () => ({
  activateProjectTab: jest.fn(),
}));
import { focusFrame } from "./navigate";
import { redux } from "@cocalc/frontend/app-framework";
it("focuses the included file's CodeMirror cursor", () => {
  const input = document.createElement("textarea");
  document.body.append(input);
  const cm = {
    focus: jest.fn(() => input.focus()),
    hasFocus: () => document.activeElement === input,
  };
  const actions = {
    set_active_id: jest.fn(),
    focus: jest.fn(),
    get_code_editor: jest.fn(() => ({
      get_actions: () => ({ _cm: { source: cm } }),
    })),
  };
  expect(focusFrame(actions, "source")).toBe(true);
  expect(actions.set_active_id).not.toHaveBeenCalled();
  expect(actions.get_code_editor).toHaveBeenCalledWith("source");
  expect(document.activeElement).toBe(input);
  expect(actions.focus).not.toHaveBeenCalled();
  input.remove();
});
it("waits for CodeMirror registration rather than accepting an unfocused source frame", () => {
  const actions = {
    set_active_id: jest.fn(),
    focus: jest.fn(),
    _get_frame_node: () => new Map([["type", "cm"]]),
  };
  expect(focusFrame(actions, "source")).toBe(false);
  expect(actions.focus).not.toHaveBeenCalled();
});
it("focuses passive frames without returning keyboard events to the source editor", () => {
  const root = document.createElement("div");
  root.dataset.frameId = "pdf";
  root.getClientRects = () => [{}] as any;
  document.body.append(root);
  const actions = { set_active_id: jest.fn(), focus: jest.fn() };
  expect(focusFrame(actions, "pdf")).toBe(true);
  expect(document.activeElement).toBe(root);
  root.blur();
  expect(root.hasAttribute("tabindex")).toBe(false);
  root.remove();
});

import { EventEmitter } from "events";
import { navigate } from "./navigate";
import { FRAME_COMMIT_EVENT } from "@cocalc/frontend/frame-editors/frame-tree/commit-event";

function navigationFixture() {
  const projectStore: any = new EventEmitter();
  const editorStore: any = new EventEmitter();
  const fileStore = new EventEmitter();
  const input = document.createElement("textarea");
  const root = document.createElement("div");
  root.dataset.frameId = "source";
  root.append(input);
  document.body.append(root);
  let visible = false;
  root.getClientRects = () => (visible ? [{}] : []) as any;
  let component: any;
  projectStore.getIn = () => component;
  editorStore.getIn = () => "source";
  const fileActions = { store: fileStore, _cm: {} };
  const actions = {
    store: editorStore,
    set_active_id: jest.fn(),
    _get_frame_node: () => new Map([["type", "cm"]]),
    get_code_editor: () => ({ get_actions: () => fileActions }),
  };
  Object.assign(redux, {
    getActions: (name) =>
      name === "projects" ? { open_project: async () => {} } : actions,
    getProjectActions: () => ({ open_file: async () => {} }),
    getProjectStore: () => projectStore,
    getStore: (name) =>
      name === "projects" ? { is_project_open: () => false } : undefined,
  });
  const focus = jest.fn(() => input.focus());
  const controller = new AbortController();
  const hasFocus = jest.spyOn(document, "hasFocus").mockReturnValue(true);
  const done = navigate(
    { kind: "file", projectId: "p", path: "main.tex", frameId: "source" },
    controller.signal,
  );
  return {
    done,
    controller,
    projectStore,
    editorStore,
    fileStore,
    input,
    actions,
    focus,
    load() {
      component = { Editor: () => null, redux_name: "latex" };
      projectStore.emit("change");
    },
    show() {
      visible = true;
      root.dispatchEvent(new Event(FRAME_COMMIT_EVENT, { bubbles: true }));
    },
    mount() {
      fileActions._cm["source"] = {
        focus,
        hasFocus: () => document.activeElement === input,
      };
      fileStore.emit("cm-mounted", "source");
    },
    cleanup() {
      controller.abort();
      root.remove();
      hasFocus.mockRestore();
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
it("waits for store, visible-frame commit, and included CodeMirror mount events, then focuses once", async () => {
  const fixture = navigationFixture();
  try {
    await flush();
    expect(fixture.projectStore.listenerCount("change")).toBe(1);
    fixture.load();
    await flush();
    expect(fixture.actions.set_active_id).toHaveBeenCalledTimes(1);
    expect(fixture.focus).not.toHaveBeenCalled();
    fixture.show();
    await flush();
    expect(fixture.fileStore.listenerCount("cm-mounted")).toBe(1);
    fixture.mount();
    await fixture.done;
    expect(fixture.focus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(fixture.input);
    expect(fixture.projectStore.listenerCount("change")).toBe(0);
    expect(fixture.editorStore.listenerCount("change")).toBe(0);
    expect(fixture.fileStore.listenerCount("cm-mounted")).toBe(0);
  } finally {
    fixture.cleanup();
  }
});
it("cancels an in-flight focus handoff without leaving subscriptions or stealing focus", async () => {
  const fixture = navigationFixture();
  try {
    await flush();
    fixture.load();
    await flush();
    fixture.show();
    await flush();
    fixture.controller.abort();
    await expect(fixture.done).rejects.toMatchObject({ name: "AbortError" });
    fixture.mount();
    expect(fixture.focus).not.toHaveBeenCalled();
    expect(fixture.fileStore.listenerCount("cm-mounted")).toBe(0);
  } finally {
    fixture.cleanup();
  }
});
it("focuses a chat composer through its DOM root when there is no input control", () => {
  const root = document.createElement("div");
  root.dataset.frameId = "chat";
  root.getClientRects = () => [{}] as any;
  const input = document.createElement("textarea");
  root.append(input);
  document.body.append(root);
  try {
    expect(
      focusFrame(
        { _get_frame_node: () => new Map([["type", "chat"]]) },
        "chat",
      ),
    ).toBe(true);
    expect(document.activeElement).toBe(input);
  } finally {
    root.remove();
  }
});

it("opens the side chat for digit 0 when the layout has no chat frame, then focuses its composer", async () => {
  const projectStore: any = new EventEmitter();
  const editorStore: any = new EventEmitter();
  const root = document.createElement("div");
  root.dataset.frameId = "chat";
  const composer = document.createElement("textarea");
  root.append(composer);
  document.body.append(root);
  let chatFrame: string | undefined;
  root.getClientRects = () => (chatFrame ? [{}] : []) as any;
  projectStore.getIn = () => ({ Editor: () => null, redux_name: "md" });
  const actions = {
    store: editorStore,
    set_active_id: jest.fn(),
    focus: jest.fn(),
    _get_most_recent_active_frame_id_of_type: (type: string) =>
      type === "chat" ? chatFrame : undefined,
    _get_frame_node: (id: string) =>
      id === chatFrame ? new Map([["type", "chat"]]) : undefined,
  };
  const open_chat = jest.fn(({ path }) => {
    expect(path).toBe("notes.md");
    chatFrame = "chat";
    editorStore.emit("change");
    root.dispatchEvent(new Event(FRAME_COMMIT_EVENT, { bubbles: true }));
  });
  Object.assign(redux, {
    getActions: (name) =>
      name === "projects" ? { open_project: async () => {} } : actions,
    getProjectActions: () => ({ open_file: async () => {}, open_chat }),
    getProjectStore: () => projectStore,
    getStore: (name) =>
      name === "projects" ? { is_project_open: () => false } : undefined,
  });
  const hasFocus = jest.spyOn(document, "hasFocus").mockReturnValue(true);
  try {
    await navigate(
      { kind: "file", projectId: "p", path: "notes.md", chat: true },
      new AbortController().signal,
    );
    expect(open_chat).toHaveBeenCalledTimes(1);
    expect(actions.set_active_id).toHaveBeenCalledWith("chat", true);
    expect(document.activeElement).toBe(composer);
  } finally {
    hasFocus.mockRestore();
    root.remove();
  }
});

it("brings an already open project to the front without re-opening it, then activates the page", async () => {
  const { activateProjectTab } = jest.requireMock(
    "@cocalc/frontend/project/page/activate-project-tab",
  );
  const open_project = jest.fn(async () => {});
  const set_active_tab = jest.fn(async () => {});
  const project = { open_file: async () => {} };
  let activeTop = "other";
  Object.assign(redux, {
    getActions: (name) =>
      name === "projects"
        ? { open_project }
        : name === "page"
          ? { set_active_tab }
          : undefined,
    getProjectActions: () => project,
    getStore: (name) =>
      name === "projects"
        ? { is_project_open: (id: string) => id === "p" }
        : name === "page"
          ? { get: () => activeTop }
          : undefined,
  });
  const signal = new AbortController().signal;
  await navigate(
    { kind: "project-page", projectId: "p", page: "files" },
    signal,
  );
  expect(open_project).not.toHaveBeenCalled();
  expect(set_active_tab).toHaveBeenCalledWith("p", true);
  expect(activateProjectTab).toHaveBeenLastCalledWith(
    project,
    "files",
    expect.objectContaining({ flyout: "files" }),
  );
  activeTop = "p";
  set_active_tab.mockClear();
  await navigate(
    { kind: "project-page", projectId: "p", page: "files" },
    signal,
  );
  expect(set_active_tab).not.toHaveBeenCalled();
  expect(open_project).not.toHaveBeenCalled();
  await navigate({ kind: "project", projectId: "closed" }, signal);
  expect(open_project).toHaveBeenCalledWith({
    project_id: "closed",
    switch_to: true,
  });
});

it("switches to a top navigation page through the page actions", async () => {
  const set_active_tab = jest.fn();
  Object.assign(redux, {
    getActions: (name) => (name === "page" ? { set_active_tab } : undefined),
  });
  await navigate(
    { kind: "app-page", page: "hosts" },
    new AbortController().signal,
  );
  expect(set_active_tab).toHaveBeenCalledWith("hosts", true);
});

it("retries focus once on the next frame and stays silent if it never sticks", async () => {
  const stubborn = navigationFixture();
  try {
    stubborn.focus.mockImplementation(() => {
      if (stubborn.focus.mock.calls.length >= 2) stubborn.input.focus();
    });
    await flush();
    stubborn.load();
    await flush();
    stubborn.show();
    await flush();
    stubborn.mount();
    await stubborn.done;
    expect(stubborn.focus).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(stubborn.input);
  } finally {
    stubborn.cleanup();
  }
  const hopeless = navigationFixture();
  try {
    hopeless.focus.mockImplementation(() => {});
    await flush();
    hopeless.load();
    await flush();
    hopeless.show();
    await flush();
    hopeless.mount();
    await expect(hopeless.done).resolves.toBeUndefined();
    expect(hopeless.focus).toHaveBeenCalledTimes(2);
  } finally {
    hopeless.cleanup();
  }
});
