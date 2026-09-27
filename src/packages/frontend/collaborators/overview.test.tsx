import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Overview } from "./overview";
import type { DirectoryApi } from "./workspace-api";

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
function fixture(coverage = "indexing") {
  const api = {
    listPeople: jest
      .fn()
      .mockResolvedValue({ items: [], coverage: "complete" }),
    listProjects: jest.fn().mockResolvedValue({
      items: [{ project_id: "project", title: "Project" }],
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
  await user.click(within(account).getByRole("button", { name: "Next" }));
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
    within(owner).getByText("Owner index: legacy sources are not all indexed."),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Use account index for conversations" }),
  ).toHaveFocus();
  await user.click(within(owner).getByRole("button", { name: "Next" }));
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
