import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Overview } from "./overview";
import type { DirectoryApi } from "./workspace-api";
jest.mock("@cocalc/frontend/account/avatar/avatar", () => ({
  Avatar: () => <span />,
}));
jest.mock("@cocalc/frontend/projects/theme", () => ({
  ProjectThemeAvatar: () => <span />,
}));

const page = (title: string, next?: string) => ({
  items: [
    {
      project_id: "project",
      resource_id: title,
      kind: "conversation",
      title,
      chat_path: "/room.chat",
      thread_id: title,
      participant_ids: [],
      activity: 1,
      created_at: 1,
      updated_at: 1,
    },
  ],
  coverage: "indexing",
  coverage_message: "Account index is incomplete.",
  next,
});
function fixture(coverage = "indexing", role = "collaborator") {
  const api = {
    getRoom: jest.fn().mockResolvedValue(null),
    listPeople: jest
      .fn()
      .mockResolvedValue({ items: [], coverage: "complete" }),
    listProjects: jest.fn().mockResolvedValue({
      items: [{ project_id: "project", title: "Project", role }],
      coverage: "complete",
    }),
    listResources: jest.fn(async ({ kind, after }) => ({
      ...(kind === "conversation"
        ? page(
            after ? "Account second" : "Account first",
            after ? undefined : "account-cursor",
          )
        : { items: [] }),
      coverage,
    })),
    listProjectResources: jest.fn(async ({ after }) => ({
      ...page(
        after ? "Owner second" : "Owner first",
        after ? undefined : "owner-cursor",
      ),
      coverage: "partial",
      coverage_message: "Owner index: legacy sources are not all indexed.",
    })),
  };
  const props = {
    accountId: "11111111-1111-4111-8111-111111111111",
    api: api as unknown as DirectoryApi,
    projectId: "project",
    personId: "person",
    onProject: jest.fn(),
    onPerson: jest.fn(),
    onResource: jest.fn(),
    onNewConversation: jest.fn(),
    onInvite: jest.fn(),
    onManageProject: jest.fn(),
  };
  return { api, props };
}

test.each(["owner", "collaborator", "viewer"])(
  "room replacement is explicitly owner-only in %s overview",
  async (role) => {
    const { api, props } = fixture("complete", role);
    render(<Overview {...props} personId={undefined} />);
    await screen.findByRole("button", { name: /Account first/ });
    const button = screen.queryByRole("button", {
      name: "Replace deleted conversation room",
    });
    expect(!!button).toBe(role === "owner");
    expect(api.getRoom).not.toHaveBeenCalled();
    expect(api.listProjects).toHaveBeenCalledWith({
      shared_only: true,
      project_id: "project",
      person_id: undefined,
      after: undefined,
      limit: 25,
    });
  },
);

test("a project-context person profile lists all shared projects, including later pages", async () => {
  const user = userEvent.setup();
  const { api, props } = fixture("complete");
  const shared = Array.from({ length: 7 }, (_, i) => ({
    project_id: i === 0 ? "project" : `project-${i}`,
    title: i === 0 ? "Fresh project" : `Shared project ${i}`,
    role: "collaborator",
  }));
  api.listProjects.mockImplementation(async ({ project_id, after }) => ({
    items: project_id
      ? shared.filter((item) => item.project_id === project_id)
      : after
        ? shared.slice(3)
        : shared.slice(0, 3),
    next: !project_id && !after ? "shared-projects-cursor" : undefined,
    coverage: "complete",
  }));
  render(<Overview {...props} />);
  const region = screen.getByRole("region", { name: "Shared projects" });
  await within(region).findByRole("button", {
    name: "Shared project 1",
    exact: true,
  });
  const more = within(region).getByRole("button", { name: "Load more" });
  more.focus();
  await user.keyboard("{Enter}");
  await within(region).findByRole("button", {
    name: "Shared project 6",
    exact: true,
  });
  for (const item of shared) {
    expect(
      within(region).getByRole("button", { name: item.title, exact: true }),
    ).toBeVisible();
  }
  expect(api.listProjects).toHaveBeenLastCalledWith({
    shared_only: true,
    project_id: undefined,
    person_id: "person",
    after: "shared-projects-cursor",
    limit: 25,
  });
  expect(
    within(region).getByRole("group", { name: "End of results" }),
  ).toHaveFocus();
  await user.click(
    within(region).getByRole("button", {
      name: "Shared project 6",
      exact: true,
    }),
  );
  expect(props.onProject).toHaveBeenCalledWith("project-6", expect.anything());
});

test("incomplete project results offer a keyboard-operated bounded owner fallback with independent cursors", async () => {
  const user = userEvent.setup();
  const { api, props } = fixture();
  render(<Overview {...props} />);
  const account = await screen.findByRole("region", {
    name: "Conversations",
    exact: true,
  });
  await within(account).findByRole("button", { name: /Account first/ });
  expect(api.listProjectResources).not.toHaveBeenCalled();
  await user.click(within(account).getByRole("button", { name: "Load more" }));
  await within(account).findByRole("button", { name: /Account second/ });
  const fallback = screen.getByRole("button", {
    name: "Browse owner indexed conversations",
  });
  fallback.focus();
  await user.keyboard("{Enter}");
  const owner = await screen.findByRole("region", {
    name: "Owner indexed conversations",
    exact: true,
  });
  await within(owner).findByRole("button", { name: /Owner first/ });
  expect(api.listProjectResources).toHaveBeenLastCalledWith({
    project_id: "project",
    person_id: "person",
    kind: "conversation",
    limit: 25,
    after: undefined,
  });
  expect(
    screen.queryByRole("button", { name: /Account second/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Use account index for conversations" }),
  ).toHaveFocus();
  const options = within(owner).getByRole("button", {
    name: "Results options",
  });
  options.focus();
  await user.keyboard("{Enter}");
  expect(
    await screen.findByRole("dialog", { name: "Results options" }),
  ).toHaveFocus();
  await waitFor(() =>
    expect(
      screen.getByText("Owner index: legacy sources are not all indexed."),
    ).toBeVisible(),
  );
  await user.keyboard("{Escape}");
  expect(options).toHaveFocus();
  await user.click(within(owner).getByRole("button", { name: "Load more" }));
  await within(owner).findByRole("button", { name: /Owner second/ });
  expect(api.listProjectResources).toHaveBeenLastCalledWith(
    expect.objectContaining({ after: "owner-cursor", limit: 25 }),
  );
  await user.click(
    screen.getByRole("button", { name: "Use account index for conversations" }),
  );
  await screen.findByRole("button", { name: /Account first/ });
  expect(api.listResources).toHaveBeenLastCalledWith(
    expect.objectContaining({
      kind: "conversation",
      after: undefined,
      scope: "all",
      limit: 25,
    }),
  );
});

test.each(["complete", "no-project"])(
  "no owner query or fallback for %s",
  async (mode) => {
    const { api, props } = fixture(
      mode === "complete" ? "complete" : "indexing",
    );
    render(
      <Overview
        {...props}
        projectId={mode === "no-project" ? undefined : "project"}
      />,
    );
    await screen.findByRole("button", { name: /Account first/ });
    expect(
      screen.queryByRole("button", { name: /Browse owner indexed/ }),
    ).not.toBeInTheDocument();
    expect(api.listProjectResources).not.toHaveBeenCalled();
  },
);

test("owner authorization failures stay explicit and permit return to the account index", async () => {
  const user = userEvent.setup();
  const { api, props } = fixture();
  api.listProjectResources.mockRejectedValueOnce(
    Error("Project access removed"),
  );
  const view = render(<Overview {...props} />);
  await user.click(
    await screen.findByRole("button", {
      name: "Browse owner indexed conversations",
    }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Project access removed",
  );
  expect(
    screen.queryByRole("button", { name: /Account first/ }),
  ).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Use account index for conversations" }),
  );
  await screen.findByRole("button", { name: /Account first/ });
  view.rerender(<Overview {...props} projectId="another-project" />);
  await waitFor(() =>
    expect(api.listResources).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: "another-project" }),
    ),
  );
  expect(api.listProjectResources).toHaveBeenCalledTimes(1);
});
jest.mock("react-virtuoso", () => require("../test/mocks/virtuoso-list"));

test("person overview keeps alias editing compact and lazily opens related work tabs", async () => {
  const user = userEvent.setup();
  const { api, props } = fixture("complete");
  api.listPeople.mockResolvedValue({
    items: [{ account_id: "person", display_name: "Bella Boo" }] as any,
    coverage: "complete",
  });
  Object.assign(api, {
    getPersonAlias: jest.fn(async () => ({ alias: "bella" })),
  });
  const onPersonAliasChange = jest.fn();
  render(
    <Overview
      {...props}
      projectId={undefined}
      onPersonAliasChange={onPersonAliasChange}
    />,
  );
  await screen.findByRole("heading", { name: "Bella Boo" });
  await screen.findByRole("button", { name: "Edit personal alias @bella" });
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(onPersonAliasChange).toHaveBeenCalledWith("bella");
  expect(
    api.listResources.mock.calls.every(
      ([query]) => query.kind === "conversation",
    ),
  ).toBe(true);
  const agents = screen.getByRole("tab", { name: "Agents" });
  agents.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByText("No agents to show.")).toBeVisible();
  expect(screen.queryByText("No artifacts to show.")).not.toBeInTheDocument();
  const projects = screen.getByRole("region", { name: "Shared projects" });
  await user.click(
    within(projects).getByRole("button", { name: "Project", exact: true }),
  );
  expect(props.onProject).toHaveBeenCalledWith("project", expect.anything());
});
