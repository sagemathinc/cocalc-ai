import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { Set as ImmutableSet } from "immutable";

const mockSetFileAction = jest.fn();
const mockNotifyUserFilesystemChange = jest.fn();

const state = {
  file_action: "delete" as const,
  checked_files: ImmutableSet<string>(["/home/user/test.txt"]),
  current_path_abs: "/home/user",
};

jest.mock("@cocalc/frontend/app-framework", () => ({
  useActions: () => ({
    set_file_action: mockSetFileAction,
  }),
  useTypedRedux: (_opts: any, key: string) => state[key],
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }) => <span data-testid={`icon-${name}`} />,
}));

jest.mock("@cocalc/frontend/project_actions", () => ({
  FILE_ACTIONS: {
    delete: {
      name: {
        id: "file_actions.delete.name",
        defaultMessage: "Delete",
      },
      icon: "trash",
    },
  },
}));

jest.mock("./context", () => ({
  useProjectContext: () => ({
    project_id: "project-1",
    notifyUserFilesystemChange: mockNotifyUserFilesystemChange,
  }),
}));

jest.mock("./explorer/action-box", () => ({
  ActionBox: ({ file_action, current_path, onUserFilesystemChange }) => (
    <div data-testid="action-box">
      {file_action}:{current_path}:{typeof onUserFilesystemChange}
    </div>
  ),
}));

import FileActionModal from "./file-action-modal";

describe("FileActionModal", () => {
  beforeEach(() => {
    mockSetFileAction.mockReset();
  });

  it("renders the shared file action modal when an action is active", () => {
    render(
      <IntlProvider locale="en">
        <FileActionModal />
      </IntlProvider>,
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByTestId("action-box").textContent).toBe(
      "delete:/home/user:function",
    );
  });

  it("does not render when there is no active file action", () => {
    state.file_action = undefined as any;
    render(
      <IntlProvider locale="en">
        <FileActionModal />
      </IntlProvider>,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
