/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fromJS } from "immutable";

import { ProjectActionsMenuContent } from "./projects-actions-menu-content";
import { ProjectActionsMenu } from "./projects-actions-menu";

jest.mock("antd", () => {
  const actual = jest.requireActual("antd");
  return {
    ...actual,
    Modal: {
      ...actual.Modal,
      error: jest.fn(),
    },
  };
});

jest.mock("react-intl", () => ({
  useIntl: () => ({
    formatMessage: (message: { defaultMessage?: string; id?: string }) =>
      message.defaultMessage ?? message.id ?? "Project",
  }),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: () => ({ close_project_tab: jest.fn() }),
    getProjectActions: () => ({ refresh_project_log: jest.fn() }),
  },
  useActions: () => ({
    archive_project: jest.fn(),
    move_project_to_host: jest.fn(),
    open_project: jest.fn(),
    toggle_hide_project: jest.fn(),
  }),
  useTypedRedux: (store: string | { project_id: string }, key: string) => {
    if (store === "account" && key === "account_id") return "account-1";
    if (store === "account" && key === "is_admin") return false;
    if (store === "projects" && key === "project_map") {
      return fromJS({
        "project-1": {
          host_id: "host-1",
          users: { "account-1": { group: "owner" } },
        },
      });
    }
    if (typeof store === "object" && key === "project_log") return fromJS([]);
    return undefined;
  },
}));

jest.mock("@cocalc/frontend/app-framework/project-runtime", () => ({
  ensureProjectReduxRuntime: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: jest.fn(),
    freshAuthModalProps: {
      open: false,
      onCancel: jest.fn(),
      onSuccess: jest.fn(),
    },
  }),
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: { name: string }) => <span aria-hidden="true">{name}</span>,
}));

jest.mock("@cocalc/frontend/i18n", () => ({
  labels: {
    explorer: { defaultMessage: "Explorer" },
    new: { defaultMessage: "New" },
    project: { defaultMessage: "Project" },
    recent_files: { defaultMessage: "Recent Files" },
  },
}));

jest.mock("@cocalc/frontend/project/page/file-tab", () => ({
  FIXED_PROJECT_TABS: {
    files: { icon: "folder" },
    log: { icon: "history" },
    new: { icon: "plus" },
    settings: { icon: "cog" },
  },
}));

jest.mock("@cocalc/frontend/project/page/flyouts/store", () => ({
  useStarredFilesManager: () => ({ starred: [] }),
}));

jest.mock("@cocalc/frontend/project/use-project-region", () => ({
  useProjectRegion: () => ({ region: "us", refresh: jest.fn() }),
}));

jest.mock("@cocalc/frontend/hosts/pick-host", () => ({
  HostPickerModal: () => null,
}));

jest.mock("./archive-project-modal", () => ({
  ArchiveProjectModal: () => null,
}));

jest.mock("./hard-delete-project-modal", () => ({
  HardDeleteProjectModal: () => null,
}));

jest.mock("./public-share-labels", () => ({
  publicShareCountFromProjectLabels: () => 0,
}));

jest.mock("./remove-myself", () => ({
  confirmRemoveMyselfFromProject: jest.fn(),
}));

jest.mock("./util", () => ({
  useFilesMenuItems: () => [],
  useRecentFiles: () => [],
  useServersMenuItems: () => [],
}));

const props = {
  record: {
    project_id: "project-1",
    title: "Project One",
    labels: {},
    state: fromJS({ state: "running" }),
  } as any,
  onToggleDetails: jest.fn(),
};

async function activateWithKeyboard(key: string) {
  const user = userEvent.setup();
  await user.tab();
  const initialTrigger = screen.getByRole("button", {
    name: "Project actions",
  });
  expect(initialTrigger).toHaveFocus();
  expect(initialTrigger).toHaveAttribute("aria-haspopup", "menu");
  expect(initialTrigger).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("menuitem")).toBeNull();

  await user.keyboard(key);

  const details = await screen.findByRole("menuitem", { name: "Details" });
  await waitFor(() => expect(details).toBeVisible());
  const activeTrigger = screen.getByRole("button", {
    name: "Project actions",
  });
  await waitFor(() =>
    expect(activeTrigger).toHaveAttribute("aria-expanded", "true"),
  );
  expect(activeTrigger).toHaveFocus();
}

describe("Project actions menu keyboard access", () => {
  test.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
  ])("the hydrated content opens with %s", async (_, key) => {
    render(<ProjectActionsMenuContent {...props} />);
    await activateWithKeyboard(key);
  });

  test.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
  ])("the initial lazy trigger opens with %s", async (_, key) => {
    render(<ProjectActionsMenu {...props} />);
    await activateWithKeyboard(key);
  });

  it("keeps the lazy mouse path to one click", async () => {
    const user = userEvent.setup();
    render(<ProjectActionsMenu {...props} />);

    await user.click(
      screen.getByRole("button", {
        name: "Project actions",
      }),
    );

    const details = await screen.findByRole("menuitem", { name: "Details" });
    await waitFor(() => expect(details).toBeVisible());
  });
});
