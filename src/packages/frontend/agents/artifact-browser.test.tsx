import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentArtifactBrowser } from "./artifact-browser";
import { agentSearchStore } from "./search-state";
import type { NamedAgent } from "@cocalc/conat/agents/personal";

const search = jest.fn();
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: { projects: { chatStoreSearch: (...args) => search(...args) } },
    },
  },
}));
jest.mock("@cocalc/frontend/chat/use-artifact-pins", () => ({
  useArtifactPins: () => ({ pins: [], error: "", setPinned: jest.fn() }),
}));
jest.mock("@cocalc/frontend/components", () => ({ Icon: () => null }));
const agents = ["one", "two"].map(
  (name) =>
    ({
      name,
      endpoint: { project_id: `p-${name}`, agent_id: name },
      path: `/${name}.chat`,
      thread_id: `t-${name}`,
    }) as NamedAgent,
);
beforeEach(() => {
  search.mockReset();
});

test("large directories stop after twenty requests and continue explicitly", async () => {
  search.mockResolvedValue({ includes_artifacts: true, hits: [] });
  const many = Array.from({ length: 21 }, (_, i) => ({
    ...agents[0],
    name: `agent-${i}`,
    thread_id: `t-${i}`,
  }));
  agentSearchStore("artifact-test-many").set({ artifactsOpen: true });
  render(
    <AgentArtifactBrowser
      accountId="artifact-test-many"
      agents={many}
      active
      onSelect={async () => {}}
    />,
  );
  await waitFor(() => expect(search).toHaveBeenCalledTimes(20));
  const more = screen.getByRole("button", {
    name: "Search more agents / artifacts",
  });
  await waitFor(() => expect(more).toBeVisible());
  await userEvent.setup().click(more);
  await waitFor(() => expect(search).toHaveBeenCalledTimes(21));
  expect(search).toHaveBeenLastCalledWith(
    expect.objectContaining({ thread_id: "t-20" }),
  );
});

test("discovers unopened sources with explicit thread scoping and opens with source identity", async () => {
  search.mockImplementation(async ({ thread_id }) => ({
    includes_artifacts: true,
    hits: [
      {
        artifact_id: "same-id",
        artifact_title: `Result ${thread_id}`,
        thread_id,
        operation_id: "op",
        artifact_kind: "file",
      },
    ],
  }));
  const onSelect = jest.fn(async () => {});
  agentSearchStore("artifact-test-1").set({ artifactsOpen: true });
  render(
    <AgentArtifactBrowser
      accountId="artifact-test-1"
      agents={agents}
      active
      onSelect={onSelect}
    />,
  );
  const target = await screen.findByRole("button", {
    name: "Open Result t-two from two",
  });
  expect(search).toHaveBeenCalledWith(
    expect.objectContaining({
      project_id: "p-one",
      thread_id: "t-one",
      artifacts: true,
      limit: 25,
      query: "",
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Open Result t-one from one" }),
    ).toBeVisible(),
  );
  target.focus();
  await userEvent.setup().keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledWith(
    expect.objectContaining({
      agent: agents[1],
      threadId: "t-two",
      historical: false,
    }),
  );
  await waitFor(() =>
    expect(agentSearchStore("artifact-test-1").get().artifactsOpen).toBe(false),
  );
});

test("old hosts are reported as partial, not empty; continuation covers unsearched sources", async () => {
  search
    .mockResolvedValueOnce({ hits: [] })
    .mockResolvedValue({ includes_artifacts: true, hits: [] });
  agentSearchStore("artifact-test-2").set({ artifactsOpen: true });
  render(
    <AgentArtifactBrowser
      accountId="artifact-test-2"
      agents={agents}
      active
      onSelect={async () => {}}
    />,
  );
  await waitFor(() =>
    expect(screen.getByText(/Project host needs an update/)).toBeVisible(),
  );
  expect(search).toHaveBeenCalledTimes(1);
  await userEvent
    .setup()
    .click(
      screen.getByRole("button", { name: "Search more agents / artifacts" }),
    );
  await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
  const input = screen.getByRole("searchbox", {
    name: "Search all agent artifacts",
  });
  input.focus();
  fireEvent.keyDown(input, { key: "Escape", keyCode: 27, which: 27 });
  await waitFor(() =>
    expect(agentSearchStore("artifact-test-2").get().artifactsOpen).toBe(false),
  );
});

test("per-source pagination resumes without dropping later pages", async () => {
  search.mockImplementation(async ({ offset, thread_id }) => ({
    includes_artifacts: true,
    hits: [
      {
        artifact_id: `id-${offset}`,
        artifact_title: `Page ${offset}`,
        thread_id,
      },
    ],
    ...(offset < 1 ? { next_offset: 1 } : {}),
  }));
  agentSearchStore("artifact-test-3").set({ artifactsOpen: true });
  render(
    <AgentArtifactBrowser
      accountId="artifact-test-3"
      agents={agents.slice(0, 1)}
      active
      onSelect={async () => {}}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Open Page 1 from one" }),
    ).toBeVisible(),
  );
  expect(search).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ offset: 1 }),
  );
});
