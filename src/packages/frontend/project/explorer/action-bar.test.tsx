import immutable from "immutable";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ActionBar } from "./action-bar";
import { BACKUPS } from "@cocalc/frontend/project/listing/use-backups";

const getBackups = jest.fn();
const setOtherSettings = jest.fn();
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

jest.mock("antd", () => {
  const Button = ({ children, disabled, onClick }: any) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
  const Div = ({ children }: any) => <div>{children}</div>;
  return {
    Button,
    Modal: Object.assign(Div, { confirm: jest.fn() }),
    Popover: Div,
    Radio: Object.assign(({ children }: any) => <div>{children}</div>, {
      Group: Div,
    }),
    Space: Object.assign(Div, { Compact: Div }),
    message: { error: jest.fn(), success: jest.fn() },
  };
});

jest.mock("react-intl", () => ({
  defineMessage: (message: any) => message,
  defineMessages: (messages: any) => messages,
  FormattedMessage: ({ defaultMessage }: any) => <>{defaultMessage}</>,
  useIntl: () => ({
    formatMessage: ({ defaultMessage }: any, values?: any) =>
      typeof defaultMessage === "string"
        ? defaultMessage
            .replace("{checked}", `${values?.checked ?? ""}`)
            .replace("{total}", `${values?.total ?? ""}`)
            .replace("{items}", `${values?.items ?? ""}`)
        : (defaultMessage ?? ""),
  }),
}));

jest.mock("@cocalc/frontend/antd-bootstrap", () => ({
  Button: ({ bsSize: _bsSize, children, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
  ButtonToolbar: ({ children }: any) => <div>{children}</div>,
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: () => ({
      set_other_settings: setOtherSettings,
    }),
  },
  useAccountOtherSetting: () => false,
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
  Gap: () => null,
  Icon: () => null,
}));

jest.mock("@cocalc/frontend/course", () => ({
  useStudentProjectFunctionality: () => ({
    disableActions: false,
  }),
}));

jest.mock("@cocalc/frontend/project/explorer/file-actions-dropdown", () => ({
  FileActionsDropdown: (props: any) => mockFileActionsDropdown(props),
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

describe("ActionBar", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("adds a dropdown Open action for selected non-directory files", () => {
    const actions = {
      open_file: jest.fn(),
      project_id: "project-1",
      set_all_files_unchecked: jest.fn(),
      set_file_list_checked: jest.fn(),
    } as any;

    render(
      <ActionBar
        project_id="project-1"
        checked_files={immutable.Set([
          "/work/a.ipynb",
          "/work/folder",
          "/work/b.py",
        ])}
        listing={
          [
            { isDir: false, name: "a.ipynb" },
            { isDir: true, name: "folder" },
            { isDir: false, name: "b.py" },
          ] as any
        }
        current_path="/work"
        actions={actions}
      />,
    );

    fireEvent.click(screen.getByText("Open"));

    expect(actions.open_file).toHaveBeenCalledTimes(2);
    expect(actions.open_file).toHaveBeenNthCalledWith(1, {
      explicit: true,
      foreground: false,
      path: "/work/a.ipynb",
    });
    expect(actions.open_file).toHaveBeenNthCalledWith(2, {
      explicit: true,
      foreground: false,
      path: "/work/b.py",
    });
  });

  it("renders selected-file actions without the legacy toolbar wrapper", () => {
    const actions = {
      open_file: jest.fn(),
      project_id: "project-1",
    } as any;

    render(
      <ActionBar
        project_id="project-1"
        checked_files={immutable.Set(["/work/a.txt", "/work/b.txt"])}
        listing={
          [
            { isDir: false, name: "a.txt" },
            { isDir: false, name: "b.txt" },
          ] as any
        }
        current_path="/work"
        actions={actions}
      />,
    );

    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText(/2 of 2 .* selected/)).toBeInTheDocument();
  });

  it("shows pending listing refresh when automatic updates are disabled", () => {
    const actions = {
      project_id: "project-1",
    } as any;
    const refresh = jest.fn();

    render(
      <ActionBar
        project_id="project-1"
        checked_files={immutable.Set()}
        listing={[{ isDir: false, name: "a.txt" }] as any}
        current_path="/work"
        actions={actions}
        hasPendingUpdate
        onRefreshListing={refresh}
        autoUpdateListing={false}
      />,
    );

    fireEvent.click(screen.getByText("Refresh"));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("ignores stale backup metadata when the project changes", async () => {
    const first = deferred<any[]>();
    const second = deferred<any[]>();
    getBackups
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const actions = {
      project_id: "project-1",
      set_all_files_unchecked: jest.fn(),
      set_file_list_checked: jest.fn(),
      open_directory: jest.fn(),
      trackRestoreOp: jest.fn(),
    } as any;

    const currentPath1 = `${BACKUPS}/old-backup`;
    const currentPath2 = `${BACKUPS}/new-backup`;
    const { rerender } = render(
      <ActionBar
        project_id="project-1"
        checked_files={immutable.Set([currentPath1])}
        listing={[]}
        current_path={currentPath1}
        actions={actions}
      />,
    );

    rerender(
      <ActionBar
        project_id="project-2"
        checked_files={immutable.Set([currentPath2])}
        listing={[]}
        current_path={currentPath2}
        actions={{ ...actions, project_id: "project-2" }}
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
