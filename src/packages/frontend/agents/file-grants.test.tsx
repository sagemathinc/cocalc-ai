/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fromJS } from "immutable";
import { FileGrants } from "./file-grants";

const accountId = "00000000-1000-4000-8000-000000000001";
const sourceProjectId = "00000000-1000-4000-8000-000000000002";
const targetProjectId = "00000000-1000-4000-8000-000000000003";
const viewerProjectId = "00000000-1000-4000-8000-000000000004";
const agentId = "00000000-1000-4000-8000-000000000005";
const saveFileGrant = jest.fn();
const revokeFileGrant = jest.fn();
const listFileGrants = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (_store, key) => {
    if (key === "account_id") return accountId;
    if (key === "project_map") {
      return fromJS({
        [sourceProjectId]: {
          title: "Source",
          users: { [accountId]: { group: "owner" } },
        },
        [targetProjectId]: {
          title: "Research data",
          users: { [accountId]: { group: "collaborator" } },
        },
        [viewerProjectId]: {
          title: "Viewer only",
          users: { [accountId]: { group: "viewer" } },
        },
      });
    }
    return undefined;
  },
}));
jest.mock("@cocalc/frontend/components", () => ({ Icon: () => <span /> }));
jest.mock("@cocalc/frontend/keyboard/boundary", () => ({
  KeyboardBoundary: ({ children }) => <div>{children}</div>,
}));
jest.mock("./file-grants-service", () => ({
  fileGrantsForAgent: async () => ({ agentId, grants: [] }),
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        agent: {
          resolveIdentity: async () => ({ agent_id: agentId }),
          registerIdentity: async () => ({ agent_id: agentId }),
          listFileGrants: (...args) => listFileGrants(...args),
          saveFileGrant: (...args) => saveFileGrant(...args),
          revokeFileGrant: (...args) => revokeFileGrant(...args),
        },
      },
    },
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  listFileGrants.mockResolvedValue([]);
  saveFileGrant.mockResolvedValue({});
  revokeFileGrant.mockResolvedValue(undefined);
});

beforeAll(() => {
  const getComputedStyle = window.getComputedStyle;
  window.getComputedStyle = (element: Element) => getComputedStyle(element);
});

test("keyboard configures read-only paths for a collaborator project", async () => {
  const user = userEvent.setup();
  render(
    <FileGrants
      projectId={sourceProjectId}
      path="agent.chat"
      threadId="thread"
      open
      onClose={jest.fn()}
    />,
  );

  const project = await screen.findByRole("combobox", { name: "Project" });
  await user.click(project);
  const target = await screen.findByRole("option", { name: /Research data/ });
  expect(
    screen.queryByRole("option", { name: /Viewer only/ }),
  ).not.toBeInTheDocument();
  expect(target).toBeInTheDocument();
  const visibleTarget = screen
    .getAllByText(/Research data/)
    .find((element) => element.closest(".ant-select-item-option"));
  expect(visibleTarget).toBeDefined();
  await user.click(visibleTarget!);

  const paths = screen.getByRole("textbox", { name: "Readable paths" });
  await user.clear(paths);
  await user.type(paths, "docs{enter}README.md");
  const save = screen.getByRole("button", { name: "Save read access" });
  expect(save).toBeEnabled();
  save.focus();
  await user.keyboard("{Enter}");

  await waitFor(() =>
    expect(saveFileGrant).toHaveBeenCalledWith({
      project_id: sourceProjectId,
      agent_id: agentId,
      target_project_id: targetProjectId,
      roots: ["docs", "README.md"],
    }),
  );
  expect(
    await screen.findByText(/Read access saved for this user and agent/),
  ).toBeInTheDocument();
});
