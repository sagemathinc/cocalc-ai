import { render, screen } from "@testing-library/react";
import FileOperationLros from "./file-operation-lros";

jest.mock("./backup-ops", () => ({
  __esModule: true,
  default: ({ project_id }: { project_id: string }) => (
    <div>backup ops {project_id}</div>
  ),
}));

jest.mock("./restore-ops", () => ({
  __esModule: true,
  default: ({ project_id }: { project_id: string }) => (
    <div>restore ops {project_id}</div>
  ),
}));

jest.mock("./move-ops", () => ({
  __esModule: true,
  default: ({ project_id }: { project_id: string }) => (
    <div>move ops {project_id}</div>
  ),
}));

jest.mock("./copy-ops", () => ({
  __esModule: true,
  default: ({ project_id }: { project_id: string }) => (
    <div>copy ops {project_id}</div>
  ),
}));

describe("FileOperationLros", () => {
  it("shows every file operation LRO panel for writable project access", () => {
    render(
      <FileOperationLros
        project_id="project-1"
        canWriteProjectFiles
        readOnlyViewer={false}
      />,
    );

    expect(screen.getByText("backup ops project-1")).toBeTruthy();
    expect(screen.getByText("restore ops project-1")).toBeTruthy();
    expect(screen.getByText("move ops project-1")).toBeTruthy();
    expect(screen.getByText("copy ops project-1")).toBeTruthy();
  });

  it("still shows copy LROs for read-only viewers", () => {
    render(
      <FileOperationLros
        project_id="project-2"
        canWriteProjectFiles={false}
        readOnlyViewer
      />,
    );

    expect(screen.queryByText("backup ops project-2")).toBeNull();
    expect(screen.getByText("copy ops project-2")).toBeTruthy();
  });
});
