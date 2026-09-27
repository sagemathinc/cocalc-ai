import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ApiKeyScope } from "@cocalc/util/db-schema/api-keys";
import { CocalcConnector } from "./cocalc-connector";

const mockApi = {
  getCocalcConnectorConfig: jest.fn(),
  saveCocalcConnectorConfig: jest.fn(),
};
const mockOpenProjectDocs = jest.fn();
jest.mock("@cocalc/frontend/docs/navigation", () => ({
  openProjectDocs: (...args) => mockOpenProjectDocs(...args),
}));
const mockRunFreshAuthAction = jest.fn(async (action: () => Promise<void>) => {
  await action();
  return true;
});

jest.mock("./api", () => ({ personalAgentApi: () => mockApi }));
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: mockRunFreshAuthAction,
    freshAuthModalProps: {},
  }),
}));
jest.mock("@cocalc/frontend/projects/select-project", () => ({
  SelectProject: ({ ariaLabel, value, exclude = [], onChange }) => (
    <select
      aria-label={ariaLabel}
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Select a project</option>
      {[
        ["00000000-0000-4000-8000-000000000001", "Source project"],
        ["22222222-2222-4222-8222-222222222222", "Project B"],
      ]
        .filter(([id]) => !exclude.includes(id) || id === value)
        .map(([id, title]) => (
          <option key={id} value={id}>
            {title}
          </option>
        ))}
    </select>
  ),
}));

const agent = {
  name: "builder",
  endpoint: {
    project_id: "00000000-0000-4000-8000-000000000001",
    agent_id: "00000000-0000-4000-8000-000000000002",
  },
} as any;

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.getCocalcConnectorConfig.mockResolvedValue(null);
  mockApi.saveCocalcConnectorConfig.mockImplementation(async (opts) => ({
    ...opts,
    revision: 1,
  }));
});

test("keyboard opens the dialog and saving uses fresh auth", async () => {
  const user = userEvent.setup();
  render(<CocalcConnector agent={agent} />);
  const trigger = screen.getByRole("button", { name: "CoCalc access" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", {
    name: "CoCalc access for @builder",
  });
  await waitFor(() =>
    expect(within(dialog).getByText("Account privileges")).toBeVisible(),
  );
  const enabled = within(dialog).getByRole("switch", {
    name: "Enable CoCalc access",
  });
  await user.click(enabled);
  expect(enabled).toHaveAttribute("aria-checked", "true");
  await user.click(within(dialog).getByRole("button", { name: "Save access" }));
  await waitFor(() =>
    expect(mockApi.saveCocalcConnectorConfig).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, expected_revision: undefined }),
    ),
  );
  expect(mockRunFreshAuthAction).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(dialog).not.toBeVisible());
});

test.each([false, true])(
  "real editor preserves defaults and restricted overrides on save/reload (composer=%s)",
  async (composer) => {
    const scope: ApiKeyScope = {
      version: 1,
      account: ["project:list"],
      all_projects: { capabilities: ["file:read"], viewer_read_roots: ["."] },
      projects: [
        {
          project_id: "22222222-2222-4222-8222-222222222222",
          capabilities: ["file:read"],
          viewer_read_roots: ["assignments", "results"],
        },
      ],
    };
    let saved = { enabled: true, revision: 4, scope };
    mockApi.getCocalcConnectorConfig.mockImplementation(async () => saved);
    mockApi.saveCocalcConnectorConfig.mockImplementation(async (opts) => {
      saved = { ...saved, scope: opts.scope, revision: saved.revision + 1 };
      return saved;
    });
    const user = userEvent.setup();
    render(<CocalcConnector agent={agent} composer={composer} />);
    const trigger = screen.getByRole("button", {
      name: composer ? "CoCalc connector" : "CoCalc access",
    });
    trigger.focus();
    await user.keyboard("{Enter}");
    const roots = await screen.findByRole("textbox", {
      name: "Allowed directories",
    });
    expect(roots).toHaveValue("assignments\nresults");
    expect(
      screen.getByRole("checkbox", { name: "All projects" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Whole project" }),
    ).not.toBeChecked();
    expect(
      screen.queryByRole("option", { name: "Source project" }),
    ).not.toBeInTheDocument();
    const account = screen.getByRole("checkbox", {
      name: "Read basic account information",
    });
    account.focus();
    await user.keyboard(" ");
    await user.click(screen.getByRole("button", { name: "Save access" }));
    const expectedScope = {
      ...scope,
      account: ["project:list", "account:read"],
    };
    await waitFor(() =>
      expect(mockApi.saveCocalcConnectorConfig).toHaveBeenCalledWith({
        agent_id: agent.endpoint.agent_id,
        source_project_id: agent.endpoint.project_id,
        enabled: true,
        expected_revision: 4,
        scope: expectedScope,
      }),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.keyboard("{Enter}");
    expect(
      await screen.findByRole("textbox", { name: "Allowed directories" }),
    ).toHaveValue("assignments\nresults");
    await user.click(screen.getByRole("button", { name: "Save access" }));
    await waitFor(() =>
      expect(mockApi.saveCocalcConnectorConfig).toHaveBeenLastCalledWith(
        expect.objectContaining({
          expected_revision: 5,
          scope: expectedScope,
        }),
      ),
    );
    expect(mockRunFreshAuthAction).toHaveBeenCalledTimes(2);
    expect(scope.account).toEqual(["project:list"]);
  },
);

test("a failed load exposes an alert and does not allow saving", async () => {
  mockApi.getCocalcConnectorConfig.mockRejectedValueOnce(
    new Error("account home unavailable"),
  );
  const user = userEvent.setup();
  render(<CocalcConnector agent={agent} />);
  await user.click(screen.getByRole("button", { name: "CoCalc access" }));
  const dialog = await screen.findByRole("dialog", {
    name: "CoCalc access for @builder",
  });
  expect(
    await within(dialog).findByText("Error: account home unavailable"),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByRole("button", { name: "Save access" }),
  ).toBeDisabled();
});

test.each([false, true])(
  "keyboard cancellation restores focus without saving (composer=%s)",
  async (composer) => {
    const user = userEvent.setup();
    render(<CocalcConnector agent={agent} composer={composer} />);
    const trigger = screen.getByRole("button", {
      name: composer ? "CoCalc connector" : "CoCalc access",
    });
    trigger.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", {
      name: "CoCalc access for @builder",
    });
    const toggle = await within(dialog).findByRole("switch", {
      name: "Enable CoCalc access",
    });
    toggle.focus();
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialog).not.toBeVisible());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(mockApi.saveCocalcConnectorConfig).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Enable CoCalc access" }),
      ).toHaveAttribute("aria-checked", "false"),
    );
  },
);

test("composer entry opens the same access settings and user guide", async () => {
  const user = userEvent.setup();
  render(<CocalcConnector agent={agent} composer />);
  const trigger = screen.getByRole("button", { name: "CoCalc connector" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const help = await screen.findByRole("button", {
    name: "Learn about CoCalc access",
  });
  help.focus();
  await user.keyboard("{Enter}");
  expect(mockOpenProjectDocs).toHaveBeenCalledWith({
    projectId: agent.endpoint.project_id,
    slug: "ai/cocalc-access",
  });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

test("a source-only legacy configuration can be disabled after redundant access is removed", async () => {
  mockApi.getCocalcConnectorConfig.mockResolvedValueOnce({
    revision: 3,
    enabled: true,
    scope: {
      version: 1,
      account: [],
      projects: [
        {
          project_id: agent.endpoint.project_id,
          capabilities: ["project:exec"],
        },
      ],
    },
  });
  const user = userEvent.setup();
  render(<CocalcConnector agent={agent} />);
  await user.click(screen.getByRole("button", { name: "CoCalc access" }));
  const toggle = await screen.findByRole("switch", {
    name: "Enable CoCalc access",
  });
  expect(toggle).toHaveAttribute("aria-checked", "true");
  await user.click(toggle);
  await user.click(screen.getByRole("button", { name: "Save access" }));
  await waitFor(() =>
    expect(mockApi.saveCocalcConnectorConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        expected_revision: 3,
        scope: { version: 1, account: [], projects: [] },
      }),
    ),
  );
});
