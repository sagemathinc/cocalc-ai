import {
  getProjectTableColumns,
  type ProjectTableRecord,
} from "./projects-table-columns";
import { render, screen } from "@testing-library/react";

jest.mock("@cocalc/frontend/feature", () => ({
  IS_MOBILE: false,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }) => <span data-testid={`icon-${name}`} />,
  TimeAgo: () => <span>time ago</span>,
  Tooltip: ({ children }: any) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/components/time-elapsed", () => ({
  TimeElapsed: () => <span>elapsed</span>,
}));

jest.mock("./collaborators-avatars", () => ({
  CollaboratorsAvatars: () => <span>collaborators</span>,
}));

jest.mock("./theme", () => ({
  ProjectThemeAvatar: () => <span>avatar</span>,
}));

const intl = {
  formatMessage: (message: { defaultMessage?: string }) =>
    message.defaultMessage ?? "Project",
} as any;

function record(
  overrides: Partial<ProjectTableRecord> = {},
): ProjectTableRecord {
  return {
    project_id: "project-1",
    starred: false,
    title: "Project One",
    description: "Description",
    hidden: false,
    collaborators: [],
    ...overrides,
  };
}

describe("getProjectTableColumns", () => {
  it("opens projects only from the title column", () => {
    const onOpenProject = jest.fn();
    const columns = getProjectTableColumns(
      jest.fn(),
      () => null,
      onOpenProject,
      { columnKey: "last_edited", order: "descend" },
      [],
      false,
      null,
      intl,
    );

    const titleColumn = columns.find((column) => column.key === "title") as any;
    const actionsColumn = columns.find(
      (column) => column.key === "actions",
    ) as any;
    const titleCell = titleColumn.onCell(record());
    const actionsCell = actionsColumn.onCell(record());

    titleCell.onClick({} as any);
    actionsCell.onClick({ stopPropagation: jest.fn() } as any);

    expect(onOpenProject).toHaveBeenCalledTimes(1);
    expect(onOpenProject.mock.calls[0][0].project_id).toBe("project-1");
  });

  it("marks scheduled deletes as not openable from the title column", () => {
    const columns = getProjectTableColumns(
      jest.fn(),
      () => null,
      jest.fn(),
      { columnKey: "last_edited", order: "descend" },
      [],
      false,
      null,
      intl,
    );

    const titleColumn = columns.find((column) => column.key === "title") as any;
    const scheduledRecord = record({
      deletionScheduled: true,
      deletionBlocked: true,
    });
    const titleCell = titleColumn.onCell(scheduledRecord);

    expect(titleCell.style.cursor).toBe("not-allowed");
    render(<>{titleColumn.render(null, scheduledRecord)}</>);
    expect(screen.getByText("Scheduled for deletion")).toBeTruthy();
  });

  it("shows failed deletes as retryable with the backend error", () => {
    const columns = getProjectTableColumns(
      jest.fn(),
      () => null,
      jest.fn(),
      { columnKey: "last_edited", order: "descend" },
      [],
      false,
      null,
      intl,
    );

    const titleColumn = columns.find((column) => column.key === "title") as any;
    const failedRecord = record({
      deleteFailed: true,
      deletionBlocked: true,
      deleteError: "project not found",
    });

    render(<>{titleColumn.render(null, failedRecord)}</>);

    expect(screen.getByText("Deletion failed - retry delete")).toBeTruthy();
    expect(screen.getByText("Error: project not found")).toBeTruthy();
  });

  it("shows project rootfs image labels and upgrade availability", () => {
    const columns = getProjectTableColumns(
      jest.fn(),
      () => null,
      jest.fn(),
      { columnKey: "last_edited", order: "descend" },
      [],
      false,
      null,
      intl,
      {
        rootfsImages: [
          {
            id: "minimal-1",
            image: "cocalc.local/rootfs/minimal:1.1",
            label: "Minimal Image",
            family: "minimal",
            version: "1.1",
          },
          {
            id: "minimal-2",
            image: "cocalc.local/rootfs/minimal:1.2",
            label: "Minimal Image",
            family: "minimal",
            version: "1.2",
            supersedes_image_id: "minimal-1",
          },
        ] as any,
      },
    );

    const titleColumn = columns.find((column) => column.key === "title") as any;

    render(
      <>
        {titleColumn.render(
          null,
          record({
            rootfs_image_id: "minimal-1",
          }),
        )}
      </>,
    );

    expect(screen.getByText("Minimal Image 1.1")).toBeTruthy();
    expect(screen.getByText("Upgrade")).toBeTruthy();
  });
});
