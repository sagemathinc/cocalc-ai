/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { ArchiveProject } from "./archive-project";

const archiveProjectMock = jest.fn();

jest.mock("antd", () => ({
  Button: ({ children, ...props }: any) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

jest.mock("react-intl", () => ({
  FormattedMessage: ({ defaultMessage, values }: any) => {
    if (!values) return defaultMessage ?? null;
    return (defaultMessage ?? "").replace(
      /\{([^}]+)\}/g,
      (_: string, key: string) => values[key] ?? "",
    );
  },
  useIntl: () => ({
    formatMessage: ({ defaultMessage }: any) => defaultMessage ?? "",
  }),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useActions: () => ({
    archive_project: (...args: any[]) => archiveProjectMock(...args),
  }),
  useTypedRedux: () => undefined,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
}));

jest.mock("@cocalc/frontend/projects/archive-project-modal", () => ({
  ArchiveProjectModal: ({ open, onArchive, projects }: any) =>
    open ? (
      <button
        type="button"
        onClick={() =>
          onArchive(projects.map((project: any) => project.project_id))
        }
      >
        confirm
      </button>
    ) : null,
}));

describe("ArchiveProject", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls the projects archive action when confirmed", () => {
    render(<ArchiveProject project_id="project-1" />);

    fireEvent.click(screen.getByText("Archive"));
    fireEvent.click(screen.getByText("confirm"));
    expect(archiveProjectMock).toHaveBeenCalledWith("project-1");
  });
});
