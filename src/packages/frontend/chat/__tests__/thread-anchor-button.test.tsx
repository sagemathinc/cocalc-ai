/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Drawer } from "antd";

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }) => <span>{name}</span>,
  Tip: ({ children, title }) => <span data-tip={title}>{children}</span>,
  Tooltip: ({ children }) => <>{children}</>,
}));

import { ThreadAnchorButton } from "../thread-anchor-button";
import { ThreadResolveButton } from "../thread-resolve-button";

describe("ThreadAnchorButton", () => {
  it("names and keyboard-activates resolve in the mobile tools drawer", async () => {
    const user = userEvent.setup();
    const resolveChatMarker = jest.fn();
    const actions = {
      getThreadMetadata: () => ({ anchor: { id: "marker-1" } }),
      frameTreeActions: {
        resolveChatMarker,
        getAnchorState: () => "available",
      },
    } as any;
    render(
      <Drawer open title="Chat tools">
        <ThreadResolveButton actions={actions} threadKey="thread-1" />
      </Drawer>,
    );
    const drawer = await screen.findByRole("dialog", { name: "Chat tools" });
    const resolve = within(drawer).getByRole("button", {
      name: "Resolve this discussion",
    });
    resolve.focus();
    await user.keyboard("{Enter}");
    const confirm = await screen.findByRole("button", {
      name: "Resolve",
      exact: true,
    });
    expect(resolveChatMarker).not.toHaveBeenCalled();
    confirm.focus();
    await user.keyboard("{Enter}");
    expect(resolveChatMarker).toHaveBeenCalledWith("marker-1", true);
  });

  it("makes the compact thread label jump to its anchor", () => {
    const jumpToAnchor = jest.fn();
    const actions = {
      getThreadMetadata: () => ({ anchor: { id: "cell-56" } }),
      frameTreeActions: {
        jumpToAnchor,
        canJumpToAnchor: () => true,
        getAnchorLabel: () => "Cell 56",
      },
    } as any;

    render(
      <ThreadAnchorButton
        actions={actions}
        threadKey="thread-1"
        label="CELL 56"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /CELL 56/ }));
    expect(jumpToAnchor).toHaveBeenCalledWith("cell-56");
  });

  it("renders a deleted cell's stored title without a dead jump link", () => {
    const actions = {
      getThreadMetadata: () => ({ anchor: { id: "deleted-cell" } }),
      frameTreeActions: {
        jumpToAnchor: jest.fn(),
        canJumpToAnchor: () => false,
        getMissingAnchorMessage: () => "This cell was deleted",
        // A stale stored label must not override the explicit validity check.
        getAnchorLabel: () => "Cell 56",
      },
    } as any;

    render(
      <ThreadAnchorButton
        actions={actions}
        threadKey="thread-1"
        label="CELL 56"
      />,
    );

    expect(screen.getByText("CELL 56")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByLabelText("This cell was deleted")).toHaveTextContent(
      "trash",
    );
    expect(
      screen.getByLabelText("This cell was deleted").parentElement,
    ).toHaveAttribute("data-tip", "This cell was deleted");
  });

  it("keeps an unloaded subfile anchor clickable without a trash icon", () => {
    const jumpToAnchor = jest.fn();
    const actions = {
      getThreadMetadata: () => ({
        anchor: { id: "subfile-anchor", path: "123.tex" },
      }),
      frameTreeActions: {
        jumpToAnchor,
        getAnchorState: () => "unloaded",
        getAnchorJumpLabel: () => "123.tex",
      },
    } as any;

    render(
      <ThreadAnchorButton
        actions={actions}
        threadKey="thread-1"
        label="SUBFILE-123 (123.TEX:5)"
      />,
    );

    expect(screen.queryByText("trash")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /SUBFILE-123 \(123.TEX:5\)/ }),
    );
    expect(jumpToAnchor).toHaveBeenCalledWith("subfile-anchor", "123.tex");
  });

  it("hides resolve while a subfile anchor is unloaded", () => {
    const actions = {
      getThreadMetadata: () => ({
        anchor: { id: "subfile-anchor", path: "123.tex" },
      }),
      frameTreeActions: {
        resolveChatMarker: jest.fn(),
        getAnchorState: () => "unloaded",
      },
    } as any;

    const { container } = render(
      <ThreadResolveButton actions={actions} threadKey="thread-1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps showing the thread label when there is no anchor", () => {
    const actions = {
      getThreadMetadata: () => ({}),
      frameTreeActions: {},
    } as any;

    render(
      <ThreadAnchorButton
        actions={actions}
        threadKey="thread-1"
        label="ORDINARY CHAT"
      />,
    );

    expect(screen.getByText("ORDINARY CHAT")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
