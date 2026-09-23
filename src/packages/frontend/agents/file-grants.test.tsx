/** @jest-environment jsdom */
import { act, render, screen, waitFor } from "@testing-library/react";
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
const loadGrants = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  useMemo: (...args) => require("react").useMemo(...args),
  useState: (...args) => require("react").useState(...args),
  useTypedRedux: (_store, key) => {
    if (key === "account_id") return accountId;
    if (key === "project_map") {
      return fromJS({
        [sourceProjectId]: {
          project_id: sourceProjectId,
          title: "Source",
          users: { [accountId]: { group: "owner" } },
        },
        [targetProjectId]: {
          project_id: targetProjectId,
          title: "Research data",
          users: { [accountId]: { group: "collaborator" } },
        },
        [viewerProjectId]: {
          project_id: viewerProjectId,
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
  fileGrantsForAgent: (...args) => loadGrants(...args),
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    get account_id() {
      return accountId;
    },
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
  loadGrants.mockResolvedValue({ agentId, grants: [] });
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

  expect(
    screen.queryByRole("textbox", { name: "Readable paths" }),
  ).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("radio", { name: "Share specific directories" }),
  );
  const paths = screen.getByRole("textbox", { name: "Readable paths" });
  await user.clear(paths);
  await user.type(paths, "docs{enter}README.md");
  const save = screen.getByRole("button", { name: "Save read access" });
  expect(save).toBeEnabled();
  act(() => save.focus());
  await user.keyboard("{Enter}");

  await waitFor(() =>
    expect(saveFileGrant).toHaveBeenCalledWith({
      project_id: sourceProjectId,
      agent_id: agentId,
      target_project_id: targetProjectId,
      roots: ["docs", "README.md"],
      mode: "read",
    }),
  );
  expect(
    await screen.findByText(/Read access saved for this user and agent/),
  ).toBeInTheDocument();
});

const grant = {
  grant_id: "grant",
  agent_id: agentId,
  target_project_id: targetProjectId,
  roots: ["docs", "results"],
  mode: "read",
};

test("permission changes require an explicit selection and are sent on save", async () => {
  loadGrants.mockResolvedValue({ agentId, grants: [grant] });
  const user = userEvent.setup();
  render(
    <FileGrants
      projectId={sourceProjectId}
      path="agent.chat"
      threadId="thread"
      open
      initialTargetProjectId={targetProjectId}
      onClose={jest.fn()}
    />,
  );
  await screen.findByRole("textbox", { name: "Readable paths" });
  expect(screen.getByRole("radio", { name: "Read-only" })).toBeChecked();
  await user.click(screen.getByRole("radio", { name: "Read & write" }));
  await user.click(
    screen.getByRole("button", { name: "Save read & write access" }),
  );
  await waitFor(() =>
    expect(saveFileGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "read-write",
        roots: ["docs", "results"],
      }),
    ),
  );
});

test("summary shows titles and paths, and keyboard Edit selects its project", async () => {
  loadGrants.mockResolvedValue({ agentId, grants: [grant] });
  const user = userEvent.setup();
  const onEdit = jest.fn();
  render(
    <FileGrants
      projectId={sourceProjectId}
      path="agent.chat"
      threadId="thread"
      open
      summary
      onClose={jest.fn()}
      onEdit={onEdit}
    />,
  );
  expect(await screen.findByText("Research data")).toBeInTheDocument();
  expect(screen.getByText("docs, results")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain(targetProjectId);
  await user.tab();
  expect(screen.getByRole("button", { name: "Edit" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onEdit).toHaveBeenCalledWith(targetProjectId);
});

test("editing restores specific roots, switches to whole project, and exposes help on demand", async () => {
  loadGrants.mockResolvedValue({ agentId, grants: [grant] });
  const user = userEvent.setup();
  render(
    <FileGrants
      projectId={sourceProjectId}
      path="agent.chat"
      threadId="thread"
      open
      initialTargetProjectId={targetProjectId}
      onClose={jest.fn()}
    />,
  );
  expect(
    await screen.findByRole("textbox", { name: "Readable paths" }),
  ).toHaveValue("docs\nresults");
  expect(screen.getByRole("checkbox", { name: "Hidden" })).toBeInTheDocument();
  expect(
    screen.queryByText(/operations already admitted may finish/i),
  ).not.toBeInTheDocument();
  const help = screen.getByRole("button", { name: "About file access" });
  act(() => help.focus());
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(
      screen.getByText(/operations already admitted may finish/i),
    ).toBeVisible(),
  );
  await user.keyboard("{Escape}");
  expect(help).toHaveFocus();
  await user.click(
    screen.getByRole("radio", { name: "Share the whole project" }),
  );
  expect(
    screen.queryByRole("textbox", { name: "Readable paths" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Save read access" }));
  await waitFor(() =>
    expect(saveFileGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        target_project_id: targetProjectId,
        roots: [""],
      }),
    ),
  );
  expect(document.body.textContent).not.toContain(targetProjectId);
});
