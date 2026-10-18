/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A Markdown cell in the Studio frame (jupyter_studio), in a trusted notebook,
// is sanitized like any notebook Markdown.  (From @lite4-opus-review's repro
// for PR #20.)

import { fromJS, Map } from "immutable";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";

let mockCellOutputProps: any;
let mockMarkdownProps: any;
let mockMarkdownResolvedUrl: any;

jest.mock("@cocalc/frontend/app-framework", () => ({
  React: require("react"),
  CSS: {},
  // unset => the Animations preference defaults to enabled
  useAccountOtherSetting: () => undefined,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }) => <span>{name}</span>,
  isIconName: () => true,
  Tooltip: ({ children }) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/i18n", () => ({
  jupyter: {
    commands: {
      run_all_cells_above_menu: {
        id: "test.run_above",
        defaultMessage: "Run all above",
      },
      run_all_cells_below_menu: {
        id: "test.run_below",
        defaultMessage: "Run all below",
      },
    },
  },
}));

jest.mock(
  "@cocalc/frontend/frame-editors/jupyter-editor/cell-notebook/hook",
  () => ({
    __esModule: true,
    default: () => ({ current: undefined }),
  }),
);

jest.mock("@cocalc/frontend/jupyter/cell-output", () => ({
  CellOutput: (props) => {
    mockCellOutputProps = props;
    return <div data-testid="cell-output" />;
  },
}));

jest.mock("@cocalc/frontend/jupyter/cell-toolbar", () => ({
  CellToolbar: () => null,
}));

jest.mock("@cocalc/frontend/jupyter/cell-input", () => ({
  CellInput: () => null,
}));

jest.mock("@cocalc/frontend/jupyter/cell-chat-button", () => ({
  CellChatButton: () => <span data-testid="cell-chat-button" />,
  CellChatCompactButton: () => <span data-testid="cell-chat-compact-button" />,
}));

jest.mock("@cocalc/frontend/jupyter/ai", () => ({
  AgentCellTool: () => null,
}));

jest.mock("@cocalc/frontend/jupyter/cell-buttonbar-menu", () => ({
  CodeBarDropdownMenu: () => null,
}));

jest.mock("./studio-code-preview", () => ({
  StudioCodePreview: () => null,
}));

jest.mock("./studio-gutter", () => ({
  StudioGutter: () => null,
  formatDuration: () => "",
  formatTimeAgo: () => "",
}));

import { StudioCell } from "./studio-cell";
import { NotebookFileContext } from "../notebook-file-context";

it("a Studio Markdown cell in a trusted notebook is sanitized", () => {
  const md =
    '<div class="ant-modal" style="position: fixed; inset: 0; z-index: 9999; background: url(https://evil.example/t.png)">overlay</div>\n';
  const { container } = render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      <NotebookFileContext trust>
        <StudioCell
          {...({
            id: "cell-1",
            index: 0,
            cell: fromJS({ id: "cell-1", cell_type: "markdown", input: md }),
            cm_options: Map(),
            mode: "escape",
            font_size: 14,
            positionInBlock: 0,
            blockSize: 1,
            headingLevel: 0,
          } as any)}
        />
      </NotebookFileContext>
    </IntlProvider>,
  );
  const el = Array.from(container.querySelectorAll("div")).find(
    (d) => d.textContent === "overlay" && d.children.length === 0,
  );
  expect(el).toBeDefined();
  // (the Studio frame's own chrome has inline styles; check the content)
  expect(el!.outerHTML).toBe("<div>overlay</div>");
});
