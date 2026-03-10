/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import NoFiles from "./no-files";

jest.mock("antd", () => ({
  Alert: ({ message }: any) => <div>{message}</div>,
}));

jest.mock("@cocalc/frontend/project/home-directory", () => ({
  getProjectHomeDirectory: jest.fn(() => "/root"),
}));

jest.mock("@cocalc/frontend/project/new/new-file-page", () => ({
  __esModule: true,
  default: ({ initialFilename }: any) => (
    <div data-testid="new-file-page">{initialFilename ?? ""}</div>
  ),
}));

describe("NoFiles", () => {
  it("shows the create-file page for empty directories in the project home tree", () => {
    render(
      <NoFiles project_id="project-1" current_path="/root/tmp" file_search="" />,
    );

    expect(screen.getByTestId("new-file-page")).not.toBeNull();
  });

  it("shows a neutral empty-state for absolute system directories outside project home", () => {
    render(
      <NoFiles project_id="project-1" current_path="/tmp" file_search="" />,
    );

    expect(screen.queryByTestId("new-file-page")).toBeNull();
    expect(screen.getByText("No files or folders to display.")).not.toBeNull();
  });

  it("still shows the create-file page when the user typed a filename", () => {
    render(
      <NoFiles
        project_id="project-1"
        current_path="/tmp"
        file_search="notes.md"
      />,
    );

    expect(screen.getByTestId("new-file-page")).not.toBeNull();
  });
});
