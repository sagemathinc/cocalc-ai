import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentCommunication } from "../agent-communication";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
jest.mock("@cocalc/frontend/agents/use-ui-preference", () => ({
  useAgentMessagingUI: () => true,
}));

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    freshAuthModalProps: {},
    runFreshAuthAction: async (fn) => {
      await fn();
      return true;
    },
  }),
}));
jest.mock("../use-chat-composer-draft", () => ({
  useChatComposerDraft: () => {
    const [input, setInput] = React.useState("");
    return { input, setInput, clearInput: async () => setInput("") };
  },
}));
jest.mock("@cocalc/frontend/components/copy-to-clipboard-util", () => ({
  copyTextToClipboard: jest.fn(async () => true),
}));
jest.mock("../agent-thread-url", () => ({
  agentThreadUrl: () => "https://example.test/thread",
  parseAgentThreadUrl: () => ({
    project_id: "p2",
    path: "b.chat",
    thread_id: "b",
  }),
}));
const source = {
  agent_id: "a",
  project_id: "p1",
  path: "a.chat",
  thread_id: "a",
  name: "Source",
  created_by: "owner",
  disabled_at: null,
};
const target = { ...source, agent_id: "b", project_id: "p2", name: "Target" };
function setup() {
  const api = {
    resolveIdentity: jest.fn(async (opts) =>
      opts.project_id === "p2" ? target : source,
    ),
    registerIdentity: jest.fn(),
    listGrants: jest.fn(async () => ({ items: [] })),
    grantMessaging: jest.fn(async () => ({
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    })),
    revokeMessaging: jest.fn(),
    listRpcLinks: jest.fn(async () => []),
    grantRpcLink: jest.fn(async () => ({
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    })),
    revokeRpcLink: jest.fn(),
  };
  return {
    api,
    props: {
      api: api as any,
      projectId: "p1",
      path: "a.chat",
      threadId: "a",
      accountId: "owner",
    },
  };
}
test("inspection is lazy and keyboard operable without submitting parent settings", async () => {
  const { api, props } = setup();
  const submit = jest.fn((event) => event.preventDefault());
  const user = userEvent.setup();
  render(
    <form onSubmit={submit}>
      <AgentCommunication {...props} />
    </form>,
  );
  expect(api.resolveIdentity).not.toHaveBeenCalled();
  await user.tab();
  const toggle = screen.getByRole("button", {
    name: "Agent communication (experimental)",
  });
  expect(document.activeElement).toBe(toggle);
  await user.keyboard("{Enter}");
  await screen.findByText("No connections yet.");
  expect(api.listRpcLinks).toHaveBeenCalledWith({
    source: { agent_id: "a", project_id: "p1" },
  });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const copy = screen.getByRole("button", {
    name: "Copy this agent's address",
  });
  copy.focus();
  await user.keyboard("{Enter}");
  expect(document.activeElement).toBe(copy);
  expect(
    jest.requireMock("@cocalc/frontend/components/copy-to-clipboard-util")
      .copyTextToClipboard,
  ).toHaveBeenCalledWith({
    text: "https://example.test/thread",
    markdown: false,
  });
  expect(submit).not.toHaveBeenCalled();
});
test("previews direction and execution account before human approval; guidance defaults off", async () => {
  const { api, props } = setup();
  const user = userEvent.setup();
  render(<AgentCommunication {...props} />);
  await user.click(
    screen.getByRole("button", { name: "Agent communication (experimental)" }),
  );
  await screen.findByText("No connections yet.");
  await user.type(
    screen.getByRole("textbox", { name: "Other agent's address" }),
    "https://example.test/b",
  );
  await user.click(screen.getByRole("button", { name: "Preview connection" }));
  await screen.findByText(/Recipient execution account: owner/);
  expect(api.grantMessaging).not.toHaveBeenCalled();
  expect(
    (
      screen.getByRole("checkbox", {
        name: "Allow guidance during active turns",
      }) as HTMLInputElement
    ).checked,
  ).toBe(false);
  await user.type(
    screen.getByRole("textbox", { name: "Approval reason" }),
    "Review my change",
  );
  await user.click(
    screen.getByRole("button", { name: "Approve one-way connection" }),
  );
  await waitFor(() =>
    expect(api.grantRpcLink).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { project_id: "p1", agent_id: "a" },
        target: { project_id: "p2", agent_id: "b" },
        ttl_seconds: 86400,
        reason: "Review my change",
        allow_guidance: false,
        link_id: expect.any(String),
      }),
    ),
  );
  expect(await screen.findByRole("status")).toBeTruthy();
});
test("a read denial cannot expose registration controls", async () => {
  const { api, props } = setup();
  const user = userEvent.setup();
  api.resolveIdentity.mockRejectedValue(new Error("not a collaborator"));
  render(<AgentCommunication {...props} />);
  await user.click(
    screen.getByRole("button", { name: "Agent communication (experimental)" }),
  );
  await screen.findByText(/not a collaborator/);
  expect(
    screen.queryByRole("button", { name: "Register this thread" }),
  ).toBeNull();
});

test("a failed refresh hides previously loaded identity and mutation controls", async () => {
  const { api, props } = setup();
  const user = userEvent.setup();
  render(<AgentCommunication {...props} />);
  await user.click(
    screen.getByRole("button", { name: "Agent communication (experimental)" }),
  );
  await screen.findByText("No connections yet.");
  expect(
    screen.getByRole("textbox", { name: "Other agent's address" }),
  ).toBeTruthy();
  api.resolveIdentity.mockRejectedValue(new Error("not a collaborator"));
  await user.click(screen.getByRole("button", { name: "Refresh connections" }));
  await screen.findByText(/not a collaborator/);
  expect(
    screen.queryByRole("textbox", { name: "Other agent's address" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy agent ID" })).toBeNull();
});

test("connection details have a named group and readable semantic text color", async () => {
  const { api, props } = setup();
  api.listRpcLinks.mockResolvedValue([
    {
      link_id: "link-1",
      source: { project_id: "p1", agent_id: "a" },
      target: { project_id: "p2", agent_id: "b" },
      reason: "Review changes",
      approved_by: "owner",
      allow_guidance: false,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    },
  ] as any);
  const user = userEvent.setup();
  render(<AgentCommunication {...props} />);
  await user.click(
    screen.getByRole("button", { name: "Agent communication (experimental)" }),
  );
  const group = await screen.findByRole("group", {
    name: "Outgoing connection link-1",
  });
  expect(group.style.color).toBe(UI_COLORS.text);
});

test("RPC refresh is keyboard operable, preserves draft and approves only V2", async () => {
  const { api, props } = setup();
  const user = userEvent.setup();
  render(<AgentCommunication {...props} />);
  await user.click(
    screen.getByRole("button", { name: "Agent communication (experimental)" }),
  );
  await screen.findByText("No connections yet.");
  await user.type(
    screen.getByRole("textbox", { name: "Other agent's address" }),
    "https://example.test/b",
  );
  const toggle = screen.getByRole("button", {
    name: "Refresh connections",
  });
  toggle.focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(api.listRpcLinks).toHaveBeenCalledWith({
      source: { project_id: "p1", agent_id: "a" },
    }),
  );
  expect(document.activeElement).toBe(toggle);
  expect(
    (
      screen.getByRole("textbox", {
        name: "Other agent's address",
      }) as HTMLInputElement
    ).value,
  ).toBe("https://example.test/b");
  await user.click(screen.getByRole("button", { name: "Preview connection" }));
  await screen.findByText(/Recipient execution account: owner/);
  await user.type(
    screen.getByRole("textbox", { name: "Approval reason" }),
    "Cross-project review",
  );
  await user.click(
    screen.getByRole("button", { name: "Approve one-way connection" }),
  );
  await waitFor(() =>
    expect(api.grantRpcLink).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { project_id: "p1", agent_id: "a" },
        target: { project_id: "p2", agent_id: "b" },
        ttl_seconds: 86400,
        allow_guidance: false,
        reason: "Cross-project review",
      }),
    ),
  );
  expect(api.grantMessaging).not.toHaveBeenCalled();
  expect(api.revokeMessaging).not.toHaveBeenCalled();
});
