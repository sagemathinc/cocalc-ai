/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Map } from "immutable";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }) => <span>{name}</span>,
  Tooltip: ({ children }) => <>{children}</>,
  isIconName: () => true,
}));

jest.mock(
  "@cocalc/frontend/frame-editors/jupyter-editor/cell-notebook/hook",
  () => ({
    __esModule: true,
    default: () => ({ current: undefined }),
  }),
);

jest.mock("./ai/agent-cell-tool", () => ({
  AgentCellTool: () => <span data-testid="agent-cell-tool" />,
}));

jest.mock("./cell-buttonbar-menu", () => ({
  CodeBarDropdownMenu: () => <span data-testid="cell-actions-menu" />,
}));

jest.mock("./cell-chat-button", () => ({
  CellChatButton: () => <span data-testid="cell-chat-button" />,
  CellChatCompactButton: ({ showIdleButton }) => (
    <span
      data-testid="cell-chat-compact-button"
      data-show-idle-button={showIdleButton ? "true" : "false"}
    />
  ),
}));

jest.mock("./cell-index-number", () => ({
  CellIndexNumber: () => <span data-testid="cell-index" />,
}));

jest.mock("./cell-output-time", () => ({
  __esModule: true,
  default: () => <span data-testid="cell-timing" />,
}));

import { CellButtonBar } from "./cell-buttonbar";
import { CODE_BAR_BTN_STYLE, MINI_BUTTONS_STYLE_INNER } from "./consts";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

it("uses theme-aware foregrounds for cell actions", () => {
  expect(CODE_BAR_BTN_STYLE.color).toBe(UI_COLORS.secondary);
  expect(MINI_BUTTONS_STYLE_INNER.color).toBe(UI_COLORS.secondary);
});

const BASE_PROPS = {
  id: "cell-1",
  cell_type: "raw" as const,
  actions: {} as any,
  cell: Map(),
  is_current: false,
  index: 0,
  is_readonly: true,
  haveAICellTools: false,
};

function renderButtonBar(showControls: boolean) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      <CellButtonBar {...BASE_PROPS} showControls={showControls} />
    </IntlProvider>,
  );
}

describe("CellButtonBar compact chat affordance", () => {
  it("shows only compact chat while idle, then the controls on hover", () => {
    const { rerender } = renderButtonBar(false);

    expect(screen.getByTestId("cell-chat-compact-button")).toBeInTheDocument();
    expect(screen.queryByTestId("cell-chat-button")).toBeNull();
    expect(screen.queryByTestId("cell-actions-menu")).toBeNull();
    expect(screen.queryByTestId("cell-index")).toBeNull();

    rerender(
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <CellButtonBar {...BASE_PROPS} showControls />
      </IntlProvider>,
    );

    expect(screen.queryByTestId("cell-chat-compact-button")).toBeNull();
    expect(screen.getByTestId("cell-chat-button")).toBeInTheDocument();
    expect(screen.getByTestId("cell-index")).toBeInTheDocument();
  });

  it("keeps chat discoverable on the selected cell while idle", () => {
    render(
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <CellButtonBar {...BASE_PROPS} is_current showControls={false} />
      </IntlProvider>,
    );

    expect(screen.getByTestId("cell-chat-compact-button")).toHaveAttribute(
      "data-show-idle-button",
      "true",
    );
  });
});
