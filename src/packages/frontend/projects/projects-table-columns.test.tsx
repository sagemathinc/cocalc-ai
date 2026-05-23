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
      jest.fn(),
      [],
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
      jest.fn(),
      [],
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
});
