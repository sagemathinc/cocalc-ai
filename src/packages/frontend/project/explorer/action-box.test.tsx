import { render, screen } from "@testing-library/react";
import { Set as ImmutableSet } from "immutable";
import { IntlProvider } from "react-intl";

import { ActionBox } from "./action-box";

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => "signed_in",
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
    const checkedFiles = ImmutableSet(
      Array.from(
        { length: 505 },
        (_, i) =>
          `/home/user/deep/path/${i}/very-long-file-name-that-should-wrap-${i}.txt`,
      ),
    );

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
    expect(
      screen.getByText("very-long-file-name-that-should-wrap-0.txt"),
    ).toBeTruthy();
  });
});
