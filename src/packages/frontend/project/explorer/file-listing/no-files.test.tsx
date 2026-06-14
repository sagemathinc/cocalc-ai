/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import NoFiles from "./no-files";
import { redux } from "@cocalc/frontend/app-framework";

jest.mock("antd", () => ({
  Alert: ({ message, title, description }: any) => (
    <div>
      <div>{title}</div>
      <div>{message}</div>
      {description}
    </div>
  ),
  Button: ({ children, className, onClick, type }: any) => (
    <button className={className} onClick={onClick} type={type}>
      {children}
    </button>
  ),
  Space: ({ children }: any) => <div>{children}</div>,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: any) => <span data-icon={name} />,
}));

jest.mock("@cocalc/frontend/project/home-directory", () => ({
  getProjectHomeDirectory: () => "/home/user",
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getProjectActions: jest.fn(),
    getProjectStore: jest.fn(),
    getStore: jest.fn(),
  },
}));

describe("NoFiles", () => {
  const getProjectActionsMock = redux.getProjectActions as jest.Mock;
  const getProjectStoreMock = redux.getProjectStore as jest.Mock;
  const getStoreMock = redux.getStore as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    getProjectStoreMock.mockReturnValue({
      get: () => null,
    });
    getStoreMock.mockReturnValue({
      isAIAllowedByPolicy: () => true,
    });
  });

  it("shows a polished first-run empty-state with direct actions", () => {
    render(
      <NoFiles
        project_id="project-1"
        current_path="/home/user"
        file_search=""
      />,
    );

    expect(screen.getByText("Welcome to your project")).not.toBeNull();
    expect(screen.getByText("Jupyter Notebook")).not.toBeNull();
    expect(screen.getByText("Chat with AI")).not.toBeNull();
    expect(screen.getByText("Upload Files")).not.toBeNull();
    expect(screen.getByText("Browse file types")).not.toBeNull();
    expect(screen.getByText("Upload Files").closest("button")).toHaveClass(
      "upload-button",
    );
  });

  it("uses a compact empty-folder state away from project home", () => {
    render(
      <NoFiles
        project_id="project-1"
        current_path="/home/user/subfolder"
        file_search=""
      />,
    );

    expect(screen.getByText("This folder is empty.")).not.toBeNull();
    expect(screen.getByText("+New")).not.toBeNull();
    expect(screen.queryByText("Welcome to your project")).toBeNull();
  });

  it("hides the AI chat action when project AI policy disables agents", () => {
    getStoreMock.mockReturnValue({
      isAIAllowedByPolicy: () => false,
    });

    render(
      <NoFiles
        project_id="project-1"
        current_path="/home/user"
        file_search=""
      />,
    );

    expect(screen.queryByText("Chat with AI")).toBeNull();
    expect(screen.getByText("Jupyter Notebook")).not.toBeNull();
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
    const setCurrentPath = jest.fn();
    getProjectActionsMock.mockReturnValue({
      setState,
      ask_filename: jest.fn(),
      set_active_tab: setActiveTab,
      set_current_path: setCurrentPath,
      set_file_search: jest.fn(),
    });

    render(
      <NoFiles
        project_id="project-1"
        current_path="/home/user"
        file_search=""
      />,
    );
    fireEvent.click(screen.getByText("Browse file types"));

    expect(setCurrentPath).toHaveBeenCalledWith("/home/user");
    expect(setActiveTab).toHaveBeenCalledWith("new");
  });

  it("uses the existing filename prompt for first-run quick actions", () => {
    const askFilename = jest.fn();
    const setCurrentPath = jest.fn();
    getProjectActionsMock.mockReturnValue({
      ask_filename: askFilename,
      setState: jest.fn(),
      set_active_tab: jest.fn(),
      set_current_path: setCurrentPath,
      set_file_search: jest.fn(),
    });

    render(
      <NoFiles
        project_id="project-1"
        current_path="/home/user"
        file_search=""
      />,
    );
    fireEvent.click(screen.getByText("Jupyter Notebook"));

    expect(setCurrentPath).toHaveBeenCalledWith("/home/user");
    expect(askFilename).toHaveBeenCalledWith("ipynb");
  });

  it("prefills the new page filename from the current filter", () => {
    const setState = jest.fn();
    const setActiveTab = jest.fn();
    const setCurrentPath = jest.fn();
    getProjectActionsMock.mockReturnValue({
      setState,
      ask_filename: jest.fn(),
      set_active_tab: setActiveTab,
      set_current_path: setCurrentPath,
      set_file_search: jest.fn(),
    });

    render(
      <NoFiles
        project_id="project-1"
        current_path="/tmp"
        file_search="a.txt"
      />,
    );
    fireEvent.click(screen.getByText("+New"));

    expect(setCurrentPath).toHaveBeenCalledWith("/tmp");
    expect(setActiveTab).toHaveBeenCalledWith("new");
    expect(setState).toHaveBeenCalledWith({
      default_filename: "a.txt",
    });
  });
});
