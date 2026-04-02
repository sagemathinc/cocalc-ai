/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { navigateBrowsingPath } from "./navigate-browsing-path";
import { redux } from "@cocalc/frontend/app-framework";

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getProjectActions: jest.fn(),
  },
}));

describe("navigateBrowsingPath", () => {
  const getProjectActionsMock = redux.getProjectActions as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("updates the shared current path for flyout navigation", () => {
    const set_current_path = jest.fn();
    const set_url_to_path = jest.fn();
    const set_all_files_unchecked = jest.fn();
    getProjectActionsMock.mockReturnValue({
      set_current_path,
      set_url_to_path,
      set_all_files_unchecked,
    });

    navigateBrowsingPath("project-1", "/tmp");

    expect(set_current_path).toHaveBeenCalledWith("/tmp");
    expect(set_url_to_path).not.toHaveBeenCalled();
    expect(set_all_files_unchecked).toHaveBeenCalled();
  });

  it("updates the browser url for main explorer navigation", () => {
    const set_current_path = jest.fn();
    const set_url_to_path = jest.fn();
    const set_all_files_unchecked = jest.fn();
    getProjectActionsMock.mockReturnValue({
      set_current_path,
      set_url_to_path,
      set_all_files_unchecked,
    });

    navigateBrowsingPath("project-1", "/scratch/demo", { updateUrl: true });

    expect(set_current_path).toHaveBeenCalledWith("/scratch/demo");
    expect(set_url_to_path).toHaveBeenCalledWith("/scratch/demo", "");
    expect(set_all_files_unchecked).toHaveBeenCalled();
  });
});
