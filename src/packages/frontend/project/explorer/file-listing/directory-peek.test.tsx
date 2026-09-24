/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import DirectoryPeek from "./directory-peek";
import useBackupsListing from "@cocalc/frontend/project/listing/use-backups";
import useListing from "@cocalc/frontend/project/listing/use-listing";

jest.mock("antd", () => ({
  Button: ({ children, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
  Dropdown: ({ children }: any) => <>{children}</>,
  Flex: ({ children }: any) => <div>{children}</div>,
  Spin: () => <span>Loading</span>,
}));

jest.mock("react-intl", () => ({
  ...jest.requireActual("react-intl"),
  useIntl: () => ({
    formatMessage: ({ defaultMessage }: any) => defaultMessage,
  }),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useAccountOtherSetting: () => false,
  useActions: () => ({ open_directory: jest.fn() }),
  useTypedRedux: () => false,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  Tooltip: ({ children }: any) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/course", () => ({
  useStudentProjectFunctionality: () => ({ disableActions: false }),
}));

jest.mock("@cocalc/frontend/editor-tmp", () => ({
  file_options: () => undefined,
}));

jest.mock("@cocalc/frontend/project/file-context-menu", () => ({
  buildFileActionItems: () => [],
}));

jest.mock("@cocalc/frontend/project/file-action-trigger", () => ({
  triggerFileAction: jest.fn(),
}));

jest.mock("@cocalc/frontend/project/explorer/dnd/file-dnd-provider", () => ({
  useFileDrag: () => ({
    dragRef: jest.fn(),
    dragListeners: {},
    dragAttributes: {},
  }),
  useFolderDrop: () => ({ dropRef: jest.fn() }),
}));

jest.mock("@cocalc/frontend/project/home-directory", () => ({
  getProjectHomeDirectory: () => "/home/user",
}));

jest.mock("@cocalc/frontend/project/listing/use-fs", () => ({
  __esModule: true,
  default: () => ({ getListing: jest.fn() }),
}));

jest.mock("@cocalc/frontend/project/listing/use-listing", () => ({
  __esModule: true,
  default: jest.fn(() => ({ listing: null, error: null })),
}));

jest.mock("@cocalc/frontend/project/listing/use-backups", () => ({
  __esModule: true,
  default: jest.fn(() => ({ listing: null, error: null })),
}));

const useListingMock = useListing as jest.Mock;
const useBackupsListingMock = useBackupsListing as jest.Mock;

describe("DirectoryPeek", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("opens a file from a backup without reading its virtual path as a filesystem directory", async () => {
    useBackupsListingMock.mockReturnValue({
      listing: [{ name: "report.txt", isDir: false, mtime: 1, size: 10 }],
      error: null,
    });
    const onOpenFile = jest.fn();
    const path = ".backups/2026-09-23T07:07:35.000Z";
    render(
      <DirectoryPeek
        project_id="project-1"
        dirPath={path}
        onClose={jest.fn()}
        onOpenFile={onOpenFile}
      />,
    );

    expect(useListingMock).toHaveBeenCalledWith(
      expect.objectContaining({ fs: null }),
    );
    expect(useBackupsListingMock).toHaveBeenCalledWith({
      project_id: "project-1",
      path,
    });
    const file = screen.getByRole("button", { name: "Open file report.txt" });
    expect(file.closest("[draggable]")).toBeNull();
    file.focus();
    await userEvent.keyboard("{Enter}");
    expect(onOpenFile).toHaveBeenCalledWith(`${path}/report.txt`);
  });

  it("uses the filesystem listing for ordinary directories", () => {
    useListingMock.mockReturnValue({
      listing: [{ name: "notes.txt", isDir: false, mtime: 1, size: 10 }],
      error: null,
    });
    render(
      <DirectoryPeek
        project_id="project-1"
        dirPath="notes"
        onClose={jest.fn()}
        onOpenFile={jest.fn()}
      />,
    );

    expect(useListingMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: "notes", fs: expect.anything() }),
    );
    expect(useBackupsListingMock).toHaveBeenCalledWith({
      project_id: "project-1",
      path: "",
    });
    expect(
      screen.getByRole("button", { name: "Open file notes.txt" }),
    ).not.toBeNull();
  });
});
