import immutable from "immutable";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { BACKUPS } from "@cocalc/frontend/project/listing/use-backups";
import { FilesSelectedControls } from "./files-controls";

const getBackups = jest.fn();
const mockFileActionsDropdown = jest.fn(({ extraItems }: any) => (
  <div>
    {(extraItems ?? []).map((item: any) => (
      <button
        disabled={item.disabled}
        key={item.key}
        onClick={item.onClick}
        type="button"
      >
        {item.key === "open-selected" ? "Open" : item.key}
      </button>
    ))}
  </div>
));

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

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    freshAuthModalProps: {},
    runFreshAuthAction: async (action: () => Promise<void>) => {
      await action();
      return true;
    },
  }),
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  TimeAgo: () => null,
  Tooltip: ({ children }: any) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/project/explorer/file-actions-dropdown", () => ({
  FileActionsDropdown: (props: any) => mockFileActionsDropdown(props),
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
    browser_id: "browser-1",
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
      open_file: jest.fn(),
      trackRestoreOp: jest.fn(),
    };
  });

  it("adds a dropdown Open action for selected non-directory files", () => {
    render(
      <FilesSelectedControls
        checked_files={immutable.Set([
          "/work/a.ipynb",
          "/work/folder",
          "/work/b.py",
        ])}
        directoryFiles={[]}
        getFile={(path) =>
          path === "/work/folder"
            ? ({ isDir: true, name: "folder" } as any)
            : ({ isDir: false, name: path.split("/").pop() } as any)
        }
        mode="top"
        project_id="project-1"
        open={jest.fn()}
        activeFile={null}
      />,
    );

    fireEvent.click(screen.getByText("Open"));

    expect(currentActions.open_file).toHaveBeenCalledTimes(2);
    expect(currentActions.open_file).toHaveBeenNthCalledWith(1, {
      explicit: true,
      foreground: true,
      path: "/work/a.ipynb",
    });
    expect(currentActions.open_file).toHaveBeenNthCalledWith(2, {
      explicit: true,
      foreground: true,
      path: "/work/b.py",
    });
    expect(mockFileActionsDropdown.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        label: "Actions",
        showEllipsis: false,
        showDown: false,
      }),
    );
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
        open={jest.fn()}
        activeFile={null}
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
        open={jest.fn()}
        activeFile={null}
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
