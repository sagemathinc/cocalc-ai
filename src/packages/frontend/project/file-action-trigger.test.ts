/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { triggerFileAction } from "./file-action-trigger";

describe("triggerFileAction", () => {
  it("uses showFileActionPanel for a single-file action", () => {
    const actions = {
      set_active_tab: jest.fn(),
      set_file_action: jest.fn(),
      set_all_files_unchecked: jest.fn(),
      set_file_list_checked: jest.fn(),
      showFileActionPanel: jest.fn(),
    };

    triggerFileAction({
      actions,
      action: "delete",
      path: "/home/user/test.txt",
      multiple: false,
    });

    expect(actions.showFileActionPanel).toHaveBeenCalledWith({
      path: "/home/user/test.txt",
      action: "delete",
    });
    expect(actions.set_active_tab).not.toHaveBeenCalled();
    expect(actions.set_file_action).not.toHaveBeenCalled();
    expect(actions.set_all_files_unchecked).not.toHaveBeenCalled();
    expect(actions.set_file_list_checked).not.toHaveBeenCalled();
  });

  it("falls back to selection state for multi-file actions", () => {
    const actions = {
      set_active_tab: jest.fn(),
      set_file_action: jest.fn(),
      set_all_files_unchecked: jest.fn(),
      set_file_list_checked: jest.fn(),
      showFileActionPanel: jest.fn(),
    };

    triggerFileAction({
      actions,
      action: "delete",
      path: "/home/user/test.txt",
      multiple: true,
    });

    expect(actions.showFileActionPanel).not.toHaveBeenCalled();
    expect(actions.set_all_files_unchecked).toHaveBeenCalled();
    expect(actions.set_file_list_checked).toHaveBeenCalledWith([
      "/home/user/test.txt",
    ]);
    expect(actions.set_active_tab).not.toHaveBeenCalled();
    expect(actions.set_file_action).toHaveBeenCalledWith("delete");
  });

  it("can activate the files tab for legacy flyout fallbacks", () => {
    const actions = {
      set_active_tab: jest.fn(),
      set_file_action: jest.fn(),
      set_all_files_unchecked: jest.fn(),
      set_file_list_checked: jest.fn(),
      showFileActionPanel: jest.fn(),
    };

    triggerFileAction({
      actions,
      action: "delete",
      path: "/home/user/test.txt",
      multiple: true,
      activateFilesTab: true,
    });

    expect(actions.set_active_tab).toHaveBeenCalledWith("files");
  });
});
