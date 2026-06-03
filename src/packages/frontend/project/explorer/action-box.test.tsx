import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Map as ImmutableMap, Set as ImmutableSet } from "immutable";
import { IntlProvider } from "react-intl";

import { ActionBox } from "./action-box";

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (store: any, key: string) => {
    if (store === "account" && key === "user_type") return "signed_in";
    if (store === "account" && key === "account_id") return "account-1";
    if (store === "account" && key === "is_admin") return false;
    if (store === "projects" && key === "project_map") {
      return ImmutableMap({
        "project-1": ImmutableMap({
          allow_collaborator_destructive_storage_actions: true,
          users: ImmutableMap({
            "account-1": ImmutableMap({ group: "collaborator" }),
          }),
        }),
      });
    }
    return undefined;
  },
}));

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: jest.fn(async (fn) => await fn()),
    freshAuthModalProps: {},
  }),
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }) => <span data-testid={`icon-${name}`} />,
  LoginLink: () => <span>Sign in</span>,
}));

jest.mock("@cocalc/frontend/project_store", () => ({
  file_actions: {
    delete: {
      name: {
        id: "file_actions.delete.name",
        defaultMessage: "Delete",
      },
      icon: "trash",
    },
  },
}));

jest.mock("@cocalc/frontend/projects/select-project", () => ({
  SelectProject: () => <div>Select project</div>,
}));

jest.mock("../directory-selector", () => ({
  __esModule: true,
  default: () => <div>Directory selector</div>,
}));

jest.mock("../utils", () => ({
  in_snapshot_path: () => false,
}));

jest.mock("./create-archive", () => ({
  __esModule: true,
  default: () => <div>Create archive</div>,
}));

jest.mock("./download", () => ({
  __esModule: true,
  default: () => <div>Download</div>,
}));

jest.mock("./rename-file", () => ({
  __esModule: true,
  default: () => <div>Rename file</div>,
}));

const actions = {
  set_all_files_unchecked: jest.fn(),
  setState: jest.fn(),
  set_file_action: jest.fn(),
  deleteFiles: jest.fn(),
  close_tab: jest.fn(),
  open_directory: jest.fn(),
} as any;

describe("ActionBox delete modal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("keeps large selected-file lists bounded and readable", () => {
    const checkedFiles = ImmutableSet([
      "/home/user/deep/path/zeta.txt",
      "/home/user/deep/path/Alpha.txt",
      "/home/user/deep/path/beta.txt",
      ...Array.from(
        { length: 502 },
        (_, i) => `/home/user/deep/path/selected-file-${i}.txt`,
      ),
    ]);

    render(
      <IntlProvider locale="en">
        <ActionBox
          display="modal"
          file_action="delete"
          checked_files={checkedFiles}
          current_path="/home/user"
          project_id="project-1"
          actions={actions}
        />
      </IntlProvider>,
    );

    const list = screen.getByTestId("selected-files-list");
    expect(list).toHaveStyle({
      overflowY: "auto",
      overflowX: "hidden",
      whiteSpace: "normal",
    });
    expect(screen.getByText("... and 5 more selected items")).toBeTruthy();
    expect(screen.getByText("selected-file-0.txt")).toBeTruthy();
    const renderedNames = Array.from(list.querySelectorAll("div")).map(
      (node) => node.textContent,
    );
    expect(renderedNames.slice(0, 3)).toEqual([
      "Alpha.txt",
      "beta.txt",
      "selected-file-0.txt",
    ]);
  });

  it("passes snapshot pruning option when deleting with the checkbox enabled", async () => {
    render(
      <IntlProvider locale="en">
        <ActionBox
          display="modal"
          file_action="delete"
          checked_files={ImmutableSet(["/home/user/foo"])}
          current_path="/home/user"
          project_id="project-1"
          actions={actions}
        />
      </IntlProvider>,
    );

    fireEvent.click(screen.getByText("Delete this path in ALL snapshots"));
    fireEvent.click(screen.getByText("Delete 1 Item"));

    await waitFor(() =>
      expect(actions.deleteFiles).toHaveBeenCalledWith({
        paths: ["/home/user/foo"],
        sudo: false,
        deleteFromSnapshots: true,
      }),
    );
  });
});
