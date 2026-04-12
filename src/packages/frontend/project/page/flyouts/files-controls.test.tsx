import immutable from "immutable";
import { act, render, screen, waitFor } from "@testing-library/react";
import { BACKUPS } from "@cocalc/frontend/project/listing/use-backups";
import { FilesSelectedControls } from "./files-controls";

const getBackups = jest.fn();

let currentPathAbs = "/";
let currentActions: any;

jest.mock("antd", () => {
  const Button = ({ children, disabled, onClick }: any) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
  const Div = ({ children }: any) => <div>{children}</div>;
  return {
    Button,
    Descriptions: Object.assign(Div, { Item: Div }),
    Modal: Div,
    Popconfirm: ({ children }: any) => <>{children}</>,
    Radio: Object.assign(({ children }: any) => <div>{children}</div>, {
      Group: Div,
    }),
    Space: Object.assign(Div, { Compact: Div }),
    Tooltip: ({ children }: any) => <>{children}</>,
    message: { error: jest.fn(), success: jest.fn() },
  };
});

jest.mock("@cocalc/frontend/app-framework", () => ({
  useActions: () => currentActions,
  useTypedRedux: () => currentPathAbs,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  TimeAgo: () => null,
}));

jest.mock("@cocalc/frontend/project/explorer/file-actions-dropdown", () => ({
  FileActionsDropdown: () => null,
}));

jest.mock("./utils", () => ({
  useSingleFile: () => ({
    isDir: false,
    mtime: Date.now(),
    name: "selected.txt",
    size: 1,
  }),
}));

jest.mock("@cocalc/frontend/project/archive-info", () => ({
  getBackups: (...args: any[]) => getBackups(...args),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        projects: {
          restoreBackup: jest.fn(),
          deleteBackup: jest.fn(),
        },
      },
    },
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("FilesSelectedControls", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentActions = {
      open_directory: jest.fn(),
      trackRestoreOp: jest.fn(),
    };
  });

  it("ignores stale backup metadata when the project changes", async () => {
    const first = deferred<any[]>();
    const second = deferred<any[]>();
    getBackups
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const path1 = `${BACKUPS}/old-backup`;
    const path2 = `${BACKUPS}/new-backup`;

    currentPathAbs = path1;
    const { rerender } = render(
      <FilesSelectedControls
        checked_files={immutable.Set([path1])}
        directoryFiles={[]}
        getFile={() => undefined}
        mode="top"
        project_id="project-1"
        showFileSharingDialog={jest.fn()}
        open={jest.fn()}
        activeFile={null}
        publicFiles={new Set()}
      />,
    );

    currentPathAbs = path2;
    rerender(
      <FilesSelectedControls
        checked_files={immutable.Set([path2])}
        directoryFiles={[]}
        getFile={() => undefined}
        mode="top"
        project_id="project-2"
        showFileSharingDialog={jest.fn()}
        open={jest.fn()}
        activeFile={null}
        publicFiles={new Set()}
      />,
    );

    await act(async () => {
      second.resolve([{ id: "new-backup", time: "2026-03-12T08:00:00.000Z" }]);
      await second.promise;
    });

    await waitFor(() => {
      expect((screen.getByText("Restore") as HTMLButtonElement).disabled).toBe(
        false,
      );
    });

    await act(async () => {
      first.resolve([{ id: "old-backup", time: "2026-03-12T07:00:00.000Z" }]);
      await first.promise;
    });

    await waitFor(() => {
      expect((screen.getByText("Restore") as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
  });
});
