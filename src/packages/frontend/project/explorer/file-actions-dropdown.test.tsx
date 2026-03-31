/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { FileActionsDropdown } from "./file-actions-dropdown";

jest.mock("react-intl", () => ({
  useIntl: () => ({
    formatMessage: ({ defaultMessage }: any) => defaultMessage ?? "",
  }),
}));

jest.mock("@cocalc/frontend/components", () => ({
  DropdownMenu: ({ items }: any) => (
    <div>
      {items.map((item) => (
        <button key={item.key} type="button" onClick={item.onClick}>
          {item.key}
        </button>
      ))}
    </div>
  ),
  Icon: () => null,
}));

jest.mock("@cocalc/frontend/project_store", () => ({
  file_actions: {
    delete: {
      name: { defaultMessage: "Delete" },
      icon: "trash",
    },
  },
}));

describe("FileActionsDropdown", () => {
  it("uses showFileActionPanelForPaths when selected paths are provided", () => {
    const actions = {
      set_active_tab: jest.fn(),
      set_file_action: jest.fn(),
      showFileActionPanelForPaths: jest.fn(),
    } as any;

    render(
      <FileActionsDropdown
        names={["delete"] as any}
        current_path="/root"
        actions={actions}
        selectedPaths={["/root/foo"]}
        activateFilesTab
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "delete" }));

    expect(actions.showFileActionPanelForPaths).toHaveBeenCalledWith({
      paths: ["/root/foo"],
      action: "delete",
    });
    expect(actions.set_active_tab).not.toHaveBeenCalled();
    expect(actions.set_file_action).not.toHaveBeenCalled();
  });

  it("falls back to direct file_action state when no selected paths are provided", () => {
    const actions = {
      set_active_tab: jest.fn(),
      set_file_action: jest.fn(),
    } as any;

    render(
      <FileActionsDropdown
        names={["delete"] as any}
        current_path="/root"
        actions={actions}
        activateFilesTab
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "delete" }));

    expect(actions.set_active_tab).toHaveBeenCalledWith("files");
    expect(actions.set_file_action).toHaveBeenCalledWith("delete");
  });
});
