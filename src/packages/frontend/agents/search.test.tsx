import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentSearch } from "./search";
import type { NamedAgent } from "@cocalc/conat/agents/personal";

const search = jest.fn();
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: { projects: { chatStoreSearch: (...args) => search(...args) } },
    },
  },
}));
jest.mock("./api", () => ({
  personalAgentApi: () => ({
    getIdentity: async () => ({ conversation_history: [] }),
  }),
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: () => undefined,
    getStore: () => ({ get: () => "search-test" }),
  },
}));
jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  TimeAgo: ({ date }) => <span>{date.toISOString()}</span>,
}));

test("drawer preserves query, filters and results through unmount; inspecting a result keeps it open until Escape", async () => {
  const user = userEvent.setup();
  search.mockResolvedValue({
    includes_head: true,
    hits: [
      {
        row_id: -1,
        segment_id: "head",
        date_ms: 1700000000000,
        excerpt: "test finding",
      },
    ],
  });
  const props = {
    accountId: "search-test",
    agents: [
      {
        name: "helper",
        endpoint: { project_id: "p", agent_id: "a" },
        thread_id: "t",
        path: "/a.chat",
        updated_at: "2026-09-21",
      } as NamedAgent,
    ],
    activity: {},
    available: () => true,
    active: true,
    onSelect: jest.fn(async () => undefined),
  };
  const first = render(<AgentSearch {...props} />);
  const trigger = screen.getByRole("button", { name: "Search conversations" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const help = screen.getByRole("button", {
    name: "About conversation search",
  });
  expect(screen.queryByRole("tooltip")).toBeNull();
  help.focus();
  await user.keyboard("{Enter}");
  expect((await screen.findByRole("tooltip")).textContent).toContain(
    'saved by "Start fresh conversation"',
  );
  expect(screen.getByRole("tooltip").textContent).toContain(
    "Current conversations are included even when agents are idle",
  );
  expect(
    screen.getByRole("region", { name: "Conversation search help" })
      .textContent,
  ).toContain("Search is not fuzzy or semantic");
  expect(screen.getByRole("tooltip").textContent).toContain(
    "Quotes are literal characters",
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  expect(document.activeElement).toBe(help);
  expect(screen.getByRole("dialog")).not.toBeNull();
  await user.click(
    screen.getByRole("checkbox", { name: "Include past conversations" }),
  );
  await user.type(
    screen.getByRole("searchbox", { name: "Search agent conversations" }),
    "test{Enter}",
  );
  await screen.findByRole("button", { name: /@helper Current conversation/ });
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("Search complete"),
  );
  first.unmount();
  render(<AgentSearch {...props} />);
  expect(
    (
      screen.getByRole("checkbox", {
        name: "Include past conversations",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  expect(
    (
      screen.getByRole("searchbox", {
        name: "Search agent conversations",
      }) as HTMLInputElement
    ).value,
  ).toBe("test");
  const hit = screen.getByRole("button", {
    name: /@helper Current conversation/,
  });
  hit.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(props.onSelect).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("dialog")).not.toBeNull();
  await user.click(screen.getByRole("button", { name: "close-circle" }));
  expect(
    (
      screen.getByRole("searchbox", {
        name: "Search agent conversations",
      }) as HTMLInputElement
    ).value,
  ).toBe("");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(search).toHaveBeenCalledTimes(1);
});
