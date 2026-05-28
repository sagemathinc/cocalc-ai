/** @jest-environment jsdom */

const mockSetPageActiveTab = jest.fn();
const mockSetPageState = jest.fn();
const mockSetFlyoutExpanded = jest.fn();
const mockGetProjectActions = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: (name: string) =>
      name === "page"
        ? {
            set_active_tab: mockSetPageActiveTab,
            setState: mockSetPageState,
          }
        : undefined,
    getProjectActions: (projectId: string) => mockGetProjectActions(projectId),
  },
}));

import {
  APP_DOCS_SELECTED_STORAGE_KEY,
  PROJECT_DOCS_OPEN_EVENT,
  normalizeDocsSlug,
  openAppDocs,
  openProjectDocs,
  projectDocsStorageKey,
} from "./navigation";

describe("docs navigation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    mockGetProjectActions.mockReturnValue({
      setFlyoutExpanded: mockSetFlyoutExpanded,
    });
  });

  it("normalizes public and app docs paths to docs slugs", () => {
    expect(normalizeDocsSlug("/docs/jupyter/use-jupyter")).toBe(
      "jupyter/use-jupyter",
    );
    expect(normalizeDocsSlug("app-docs/files/markdown")).toBe("files/markdown");
    expect(normalizeDocsSlug("terminal/use-terminal")).toBe(
      "terminal/use-terminal",
    );
  });

  it("opens a project docs page in the docs flyout", () => {
    const listener = jest.fn();
    window.addEventListener(PROJECT_DOCS_OPEN_EVENT, listener);

    openProjectDocs({
      projectId: "project-1",
      slug: "/docs/jupyter/use-jupyter",
    });

    expect(
      window.localStorage.getItem(projectDocsStorageKey("project-1")),
    ).toBe("jupyter/use-jupyter");
    expect(mockSetPageActiveTab).toHaveBeenCalledWith("project-1", false);
    expect(mockSetFlyoutExpanded).toHaveBeenCalledWith("docs", true);
    expect(listener).toHaveBeenCalled();
    expect(listener.mock.calls[0][0].detail).toEqual({
      projectId: "project-1",
      slug: "jupyter/use-jupyter",
    });

    window.removeEventListener(PROJECT_DOCS_OPEN_EVENT, listener);
  });

  it("opens a global app docs page", () => {
    openAppDocs("/docs/admin/users");

    expect(window.localStorage.getItem(APP_DOCS_SELECTED_STORAGE_KEY)).toBe(
      "admin/users",
    );
    expect(mockSetPageState).toHaveBeenCalledWith({
      docs_print: false,
      docs_slug: "admin/users",
    });
    expect(mockSetPageActiveTab).toHaveBeenCalledWith("docs", true);
  });
});
