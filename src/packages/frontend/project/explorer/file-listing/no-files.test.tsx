/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import NoFiles from "./no-files";
import { redux } from "@cocalc/frontend/app-framework";

jest.mock("antd", () => ({
  Alert: ({ message, description }: any) => (
    <div>
      <div>{message}</div>
      {description}
    </div>
  ),
  Button: ({ children, onClick }: any) => (
    <button onClick={onClick}>{children}</button>
  ),
  Space: ({ children }: any) => <div>{children}</div>,
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getProjectActions: jest.fn(),
    getProjectStore: jest.fn(),
  },
}));

describe("NoFiles", () => {
  const getProjectActionsMock = redux.getProjectActions as jest.Mock;
  const getProjectStoreMock = redux.getProjectStore as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    getProjectStoreMock.mockReturnValue({
      get: () => null,
    });
  });

  it("shows an empty-state alert with +New", () => {
    render(
      <NoFiles project_id="project-1" current_path="/tmp" file_search="" />,
    );

    expect(screen.getByText("No files or folders to display.")).not.toBeNull();
    expect(screen.getByText("+New")).not.toBeNull();
  });

  it("shows a matching-files warning with a clear-filter button", () => {
    render(
      <NoFiles
        project_id="project-1"
        current_path="/tmp"
        file_search="notes"
      />,
    );

    expect(
      screen.getByText("No files or folders match the current filter."),
    ).not.toBeNull();
    expect(screen.getByText("Clear filter")).not.toBeNull();
    expect(screen.getByText("+New")).not.toBeNull();
  });

  it("opens the new page in the current folder", () => {
    const setState = jest.fn();
    const setActiveTab = jest.fn();
    getProjectActionsMock.mockReturnValue({
      setState,
      set_active_tab: setActiveTab,
      set_file_search: jest.fn(),
    });

    render(
      <NoFiles project_id="project-1" current_path="/tmp" file_search="" />,
    );
    fireEvent.click(screen.getByText("+New"));

    expect(setState).toHaveBeenCalledWith({ new_page_path_abs: "/tmp" });
    expect(setActiveTab).toHaveBeenCalledWith("new");
  });
});
