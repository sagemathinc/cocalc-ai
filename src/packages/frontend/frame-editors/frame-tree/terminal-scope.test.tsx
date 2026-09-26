/** @jest-environment jsdom */

import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fromJS, Map } from "immutable";
import { terminalScopeView } from "./terminal-scope";
import { FrameTree } from "./frame-tree";
import { TabsContainer } from "./tabs-container";

jest.mock("@cocalc/frontend/app-framework", () => ({
  ...jest.requireActual("react"),
  redux: {},
  useRedux: () => undefined,
}));
jest.mock("@cocalc/frontend/components", () => ({ Loading: () => null }));
jest.mock("@cocalc/frontend/i18n", () => ({ isIntlMessage: () => false }));
jest.mock("../code-editor/editor", () => ({ cm: {} }));
jest.mock("./frame-leaf-container", () => ({
  FrameLeafContainer: ({ leaf }) => leaf,
}));
jest.mock("./frame-tree-drag-bar", () => ({ FrameTreeDragBar: () => null }));
jest.mock("./title-bar", () => ({ FrameTitleBar: () => null }));
jest.mock("./leaf", () => ({
  FrameTreeLeaf: ({ desc }) => <textarea aria-label={desc.get("id")} />,
}));

const chat = { id: "chat", type: "chatroom", "data-selectedThreadKey": "a" };
const a = { id: "shell-a", type: "terminal", "data-terminalScope": "a" };
const b = { id: "shell-b", type: "terminal", "data-terminalScope": "b" };
const legacy = { id: "legacy", type: "terminal" };

it("keeps a second chat frame's scope when focus moves into its terminal", () => {
  const tree: any = fromJS({
    id: "root",
    type: "node",
    children: [
      chat,
      { ...chat, id: "chat-b", "data-selectedThreadKey": "b" },
      a,
      b,
    ],
  });
  const view = terminalScopeView(tree, "shell-b");
  expect(view.isVisible(fromJS(b) as any)).toBe(true);
  expect(view.isVisible(fromJS(a) as any)).toBe(false);
});

it("keeps the chat input mounted when hiding the only scoped split", async () => {
  const user = userEvent.setup();
  const view = (scope) => {
    const tree = fromJS({
      id: "root",
      type: "node",
      direction: "col",
      first: { ...chat, "data-selectedThreadKey": scope },
      second: a,
    });
    const props: any = {
      actions: {},
      active_id: "chat",
      frame_tree: tree,
      local_view_state: Map({ frame_tree: tree }),
      value: "",
      reload: Map(),
      editor_spec: {
        chatroom: { component: () => null },
        terminal: { component: () => null },
      },
    };
    return <FrameTree {...props} />;
  };
  const rendered = render(view("a"));
  const input = screen.getByRole("textbox", { name: "chat" });
  await user.type(input, "draft");
  rendered.rerender(view("b"));
  expect(screen.queryByRole("textbox", { name: "shell-a" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "chat" })).toBe(input);
  expect(input).toHaveFocus();
  expect(input).toHaveValue("draft");
});

it("omits off-thread tabs without renumbering persisted tab selection", async () => {
  const user = userEvent.setup();
  const tree: any = fromJS({
    id: "root",
    type: "node",
    children: [chat, a, b, legacy],
  });
  const scope = terminalScopeView(tree, "chat");
  const tabs: any = fromJS({
    id: "tabs",
    type: "tabs",
    activeTab: 0,
    children: [b, a, legacy].map((node) => ({
      ...node,
      "data-tabLabel": node.id,
    })),
  });
  const actions = {
    name: "test",
    set_frame_tree: jest.fn(),
    set_active_id: jest.fn(),
  };
  render(
    <TabsContainer
      frame_tree={tabs}
      actions={actions}
      editor_spec={{}}
      childIsVisible={scope.isVisible}
      renderChild={(node) => <textarea aria-label={node.get("id")} />}
    />,
  );
  expect(screen.queryByRole("tab", { name: /shell-b/ })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "shell-b" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "shell-a" })).toBeVisible();
  screen.getByRole("tab", { name: /legacy/ }).focus();
  await user.keyboard("{Enter}");
  expect(actions.set_frame_tree).toHaveBeenCalledWith({
    id: "tabs",
    activeTab: 2,
  });
  expect(actions.set_active_id).toHaveBeenCalledWith("legacy", true);
});

it("hides off-thread nested shells but preserves legacy shells and persisted nodes", () => {
  const tree: any = fromJS({
    id: "root",
    type: "node",
    first: chat,
    second: { id: "tabs", type: "tabs", children: [a, b, legacy] },
  });
  const view = terminalScopeView(tree, "shell-b");
  expect(view.isVisible(fromJS(a) as any)).toBe(true);
  expect(view.isVisible(fromJS(b) as any)).toBe(false);
  expect(view.isVisible(fromJS(legacy) as any)).toBe(true);
  expect(view.visibleId("shell-b")).toBe("chat");
  expect(view.visibleId("legacy")).toBe("legacy");
  expect(tree.getIn(["second", "children"]).size).toBe(3);
  expect(terminalScopeView(fromJS(b) as any).isVisible(fromJS(b) as any)).toBe(
    true,
  );
});

it.each([false, true])(
  "removes off-thread input and restores it on return (legacy layout=%s)",
  async (oldLayout) => {
    const user = userEvent.setup();
    const tree = fromJS(
      oldLayout
        ? {
            id: "root",
            type: "node",
            direction: "col",
            first: chat,
            second: {
              id: "shells",
              type: "node",
              direction: "col",
              first: a,
              second: {
                id: "other",
                type: "node",
                direction: "col",
                first: b,
                second: legacy,
              },
            },
          }
        : {
            id: "root",
            type: "node",
            direction: "col",
            children: [chat, a, b, legacy],
          },
    ) as Map<string, any>;
    const props: any = {
      actions: {},
      active_id: "chat",
      path: "agent.chat",
      project_id: "p",
      value: "",
      reload: Map(),
      editor_spec: {
        chatroom: { component: () => null },
        terminal: { component: () => null },
      },
    };
    function view(scope: string, full_id?: string) {
      const next = tree.setIn(
        oldLayout
          ? ["first", "data-selectedThreadKey"]
          : ["children", 0, "data-selectedThreadKey"],
        scope,
      );
      return (
        <FrameTree
          {...props}
          frame_tree={next}
          full_id={full_id}
          local_view_state={Map({ frame_tree: next })}
        />
      );
    }
    const rendered = render(view("a"));
    expect(screen.queryByRole("textbox", { name: "shell-b" })).toBeNull();
    screen.getByRole("textbox", { name: "shell-a" }).focus();
    // A hidden maximized shell must not leave a blank, inescapable editor.
    rendered.rerender(view("b", "shell-a"));
    expect(screen.queryByRole("textbox", { name: "shell-a" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "chat" })).toBeVisible();
    screen.getByRole("textbox", { name: "chat" }).focus();
    await user.tab();
    expect(screen.getByRole("textbox", { name: "shell-b" })).toHaveFocus();
    await user.keyboard("echo B");
    expect(screen.getByRole("textbox", { name: "shell-b" })).toHaveValue(
      "echo B",
    );
    await user.tab();
    expect(screen.getByRole("textbox", { name: "legacy" })).toHaveFocus();
    rendered.rerender(view("a"));
    expect(screen.getByRole("textbox", { name: "shell-a" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "shell-b" })).toBeNull();
  },
);
