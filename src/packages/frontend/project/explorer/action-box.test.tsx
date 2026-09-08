import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Map as ImmutableMap, Set as ImmutableSet } from "immutable";
import { IntlProvider } from "react-intl";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

import {
  ActionBox,
  crossProjectCopySourcePath,
  crossProjectSingleItemDestPath,
} from "./action-box";

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
    copy: {
      name: {
        id: "file_actions.copy.name",
        defaultMessage: "Copy",
      },
      icon: "files",
    },
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
  default: ({ onSelect }) => (
    <button onClick={() => onSelect("/home/user/target")}>Choose target</button>
  ),
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
    expect(list.style.color).toBe(UI_COLORS.text);
    expect(list.style.backgroundColor).toBe(UI_COLORS.inset);
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

describe("crossProjectSingleItemDestPath", () => {
  it("copies a single source file into the selected home directory", () => {
    expect(
      crossProjectSingleItemDestPath({
        paths: ["/home/user/scratch/test.ipynb"],
        destinationDirectory: "/home/user",
      }),
    ).toBe("/home/user/test.ipynb");
  });

  it("copies a single source file into a selected relative directory", () => {
    expect(
      crossProjectSingleItemDestPath({
        paths: ["scratch/test.ipynb"],
        destinationDirectory: "k2",
      }),
    ).toBe("k2/test.ipynb");
  });

  it("uses the basename when the destination is the project home shortcut", () => {
    expect(
      crossProjectSingleItemDestPath({
        paths: ["scratch/test.ipynb"],
        destinationDirectory: "",
      }),
    ).toBe("test.ipynb");
  });

  it("leaves multi-source destinations as directories for backend expansion", () => {
    expect(
      crossProjectSingleItemDestPath({
        paths: ["a.txt", "b.txt"],
        destinationDirectory: "target",
      }),
    ).toBe("target");
  });
});

describe("crossProjectCopySourcePath", () => {
  it("uses string semantics for one selected path", () => {
    expect(crossProjectCopySourcePath(["/home/user/test.ipynb"])).toBe(
      "/home/user/test.ipynb",
    );
  });

  it("keeps array semantics for multiple selected paths", () => {
    const paths = ["/home/user/a.txt", "/home/user/b.txt"];
    expect(crossProjectCopySourcePath(paths)).toEqual(paths);
  });
});

describe("ActionBox copy", () => {
  it("waits for open files to save before copying from disk", async () => {
    let finishSave: () => void = () => {};
    const save_all_files = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const copyPaths = jest.fn();
    const copyActions = {
      ...actions,
      save_all_files,
      copyPaths,
      copyPathBetweenProjects: jest.fn(),
    } as any;

    render(
      <IntlProvider locale="en">
        <ActionBox
          display="modal"
          file_action="copy"
          checked_files={ImmutableSet(["/home/user/source/test.ipynb"])}
          current_path="/home/user/source"
          project_id="project-1"
          actions={copyActions}
        />
      </IntlProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Choose target" }));
    fireEvent.click(screen.getByRole("button", { name: /Copy 1 Item/i }));

    expect(save_all_files).toHaveBeenCalledTimes(1);
    expect(copyPaths).not.toHaveBeenCalled();

    finishSave();
    await waitFor(() =>
      expect(copyPaths).toHaveBeenCalledWith({
        src: ["/home/user/source/test.ipynb"],
        dest: "/home/user/target",
      }),
    );
  });
});
