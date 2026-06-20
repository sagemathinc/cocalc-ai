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
  Input: ({ onChange, placeholder, value }: any) => (
    <input
      aria-label={placeholder}
      onChange={onChange}
      placeholder={placeholder}
      value={value}
    />
  ),
  Modal: ({ children, open, title }: any) =>
    open ? (
      <div role="dialog">
        <h2>{title}</h2>
        {children}
      </div>
    ) : null,
  Segmented: ({ "aria-label": ariaLabel, onChange, options, value }: any) => (
    <div aria-label={ariaLabel}>
      {options.map((option: any) => {
        const item =
          typeof option === "string"
            ? { label: option, value: option }
            : option;
        return (
          <button
            aria-pressed={value === item.value}
            key={item.value}
            onClick={() => onChange?.(item.value)}
            type="button"
          >
            {item.label}
          </button>
        );
      })}
    </div>
  ),
  Space: ({ children }: any) => <div>{children}</div>,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: any) => <span data-icon={name} />,
  Tooltip: ({ children }: any) => <>{children}</>,
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

  it("shows a compact first-run empty-state with direct actions", () => {
    const openUploadFiles = jest.fn();
    render(
      <NoFiles
        project_id="project-1"
        current_path="/home/user"
        file_search=""
        openUploadFiles={openUploadFiles}
      />,
    );

    expect(screen.getByText("No files yet")).not.toBeNull();
    expect(screen.getByTestId("empty-directory-welcome")).toHaveStyle({
      margin: "26px auto",
      width: "calc(100% - 48px)",
      maxWidth: "900px",
    });
    expect(screen.getByText("Notebook")).not.toBeNull();
    expect(screen.getByText("Agents")).not.toBeNull();
    expect(screen.getByText("Upload")).not.toBeNull();
    expect(screen.getByText("Folder")).not.toBeNull();
    expect(screen.getByText("More")).not.toBeNull();
    expect(
      screen.getByLabelText(
        "Create a Jupyter notebook for code, text, plots, and results.",
      ),
    ).not.toBeNull();
    expect(
      screen.getByLabelText("Start an AI agent thread in this project."),
    ).not.toBeNull();
    expect(screen.queryByText("Empty project")).toBeNull();
    expect(screen.getByText("Upload").closest("button")).toHaveClass(
      "upload-button",
    );
    fireEvent.click(screen.getByText("Upload"));
    expect(openUploadFiles).toHaveBeenCalled();
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
    expect(screen.queryByText("No files yet")).toBeNull();
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

    expect(screen.queryByText("Agents")).toBeNull();
    expect(screen.getByText("Notebook")).not.toBeNull();
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

  it("opens more file types in a modal without changing pages", () => {
    const askFilename = jest.fn();
    const setActiveTab = jest.fn();
    const setCurrentPath = jest.fn();
    getProjectActionsMock.mockReturnValue({
      ask_filename: askFilename,
      setState: jest.fn(),
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
    fireEvent.click(screen.getByText("More"));

    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(screen.getByText("More file types")).not.toBeNull();
    expect(screen.getByText("Python")).not.toBeNull();
    expect(screen.getByText("Recommended")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("Grid")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("more-file-types-list")).toHaveStyle({
      gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
    });

    fireEvent.click(screen.getByText("A-Z"));
    expect(screen.getByText("A-Z")).toHaveAttribute("aria-pressed", "true");
    expect(
      screen
        .getByText("CSV File")
        .compareDocumentPosition(screen.getByText("Python")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    fireEvent.click(screen.getByText("List"));
    expect(screen.getByText("List")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("more-file-types-list")).toHaveStyle({
      gridTemplateColumns: "1fr",
    });
    expect(setActiveTab).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Python"));

    expect(setCurrentPath).toHaveBeenCalledWith("/home/user");
    expect(askFilename).toHaveBeenCalledWith("py");
    expect(setActiveTab).not.toHaveBeenCalled();
  });

  it("routes More file types through the guarded New page when creation is read-only", () => {
    const askFilename = jest.fn();
    const setActiveTab = jest.fn();
    const setCurrentPath = jest.fn();
    getProjectActionsMock.mockReturnValue({
      ask_filename: askFilename,
      setState: jest.fn(),
      set_active_tab: setActiveTab,
      set_current_path: setCurrentPath,
      set_file_search: jest.fn(),
    });

    render(
      <NoFiles
        project_id="project-1"
        current_path="/home/user"
        file_search=""
        canCreateFiles={false}
      />,
    );
    fireEvent.click(screen.getByText("More"));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(setCurrentPath).toHaveBeenCalledWith("/home/user");
    expect(setActiveTab).toHaveBeenCalledWith("new");
    expect(askFilename).not.toHaveBeenCalled();
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
    fireEvent.click(screen.getByText("Notebook"));

    expect(setCurrentPath).toHaveBeenCalledWith("/home/user");
    expect(askFilename).toHaveBeenCalledWith("ipynb");
  });

  it("uses the existing folder filename prompt from the first-run folder action", () => {
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
    fireEvent.click(screen.getByText("Folder"));

    expect(setCurrentPath).toHaveBeenCalledWith("/home/user");
    expect(askFilename).toHaveBeenCalledWith("/");
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
