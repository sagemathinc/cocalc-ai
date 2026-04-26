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
  Popconfirm: ({ children, onConfirm }: any) => (
    <div>
      {children}
      <button type="button" onClick={onConfirm}>
        confirm
      </button>
    </div>
  ),
}));

jest.mock("@ant-design/icons", () => ({
  InboxOutlined: () => null,
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
}));

jest.mock("@cocalc/frontend/i18n", () => ({
  labels: {
    project: {
      defaultMessage: "Project",
    },
  },
}));

jest.mock("@cocalc/frontend/i18n/components", () => ({
  CancelText: () => <>Cancel</>,
}));

describe("ArchiveProject", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls the projects archive action when confirmed", () => {
    render(<ArchiveProject project_id="project-1" />);

    fireEvent.click(screen.getByText("confirm"));
    expect(archiveProjectMock).toHaveBeenCalledWith("project-1");
  });
});
