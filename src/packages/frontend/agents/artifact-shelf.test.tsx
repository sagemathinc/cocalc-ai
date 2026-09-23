import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { ArtifactShelf } from "./artifact-shelf";
import { artifactIdentity, catalogResults } from "./artifact-catalog-store";
import type { CatalogEntry } from "./artifact-catalog-store";

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }) => <span data-testid={`icon-${name}`} aria-hidden="true" />,
  Tooltip: ({ children }) => children,
}));

const agent = {
  name: "One",
  endpoint: { project_id: "project", agent_id: "one" },
  path: "one.chat",
  thread_id: "thread",
} as NamedAgent;
const entries: CatalogEntry[] = Array.from({ length: 3000 }, (_, i) => ({
  entry_id: `${i}`,
  project_id: "project",
  chat_path: "one.chat",
  item: {
    artifact_id: `${i}`,
    thread_id: "thread",
    title: `Artifact ${i}`,
    kind: "file",
    created_at: i,
    publication: { operation_id: "op", message_id: "msg" },
  },
}));

test("bounds mounting to 40, preserving pin order then creation order", () => {
  const all = catalogResults(entries, [agent]);
  const pins = [artifactIdentity(all[2999]), artifactIdentity(all[2998])];
  const results = catalogResults(entries, [agent], { pins });
  render(
    <ArtifactShelf
      results={results}
      scope="agent"
      hasActiveAgent
      onScope={jest.fn()}
      onBrowse={jest.fn()}
      onOpen={jest.fn()}
      pins={pins}
      onPin={jest.fn()}
      opening={false}
      loading={false}
    />,
  );
  const items = screen.getAllByRole("listitem");
  expect(items).toHaveLength(40);
  expect(
    within(items[0]).getByRole("button", { name: "Open Artifact 0 from One" }),
  ).toBeVisible();
  expect(
    within(items[1]).getByRole("button", { name: "Open Artifact 1 from One" }),
  ).toBeVisible();
  expect(
    within(items[2]).getByRole("button", {
      name: "Open Artifact 2999 from One",
    }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Browse all (3000)" }),
  ).toBeVisible();
  const shelf = screen.getByRole("region", { name: "Artifact shelf" });
  const strip = screen.getByRole("list", { name: "Cached artifacts" });
  // JSDOM cannot measure reflow; guard the shrink/wrap layout contract.
  expect(shelf).toHaveStyle({ display: "flex", flexWrap: "wrap", minWidth: 0 });
  expect(strip.parentElement).toBe(shelf);
  expect(strip).toHaveStyle({
    minWidth: 0,
    flex: "1 1 240px",
    overflowX: "auto",
  });
});

test("artifact kinds use distinct decorative icons without changing button labels", () => {
  const kinds = ["markdown", "file", "actions", "github-pr", "commit"] as const;
  const results = catalogResults(
    entries.slice(0, kinds.length).map((entry, i) => ({
      ...entry,
      item: { ...entry.item, kind: kinds[i] },
    })),
    [agent],
  );
  render(
    <ArtifactShelf
      results={results}
      scope="agent"
      hasActiveAgent
      onScope={jest.fn()}
      onBrowse={jest.fn()}
      onOpen={jest.fn()}
      pins={[]}
      onPin={jest.fn()}
      opening={false}
      loading={false}
    />,
  );
  ["markdown", "file", "bolt", "github", "git"].forEach((icon, i) => {
    const button = screen.getByRole("button", {
      name: `Open Artifact ${i} from One`,
    });
    expect(within(button).getByTestId(`icon-${icon}`)).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});

test("native keyboard controls open, pin, browse and retain focus when pin order changes", async () => {
  const user = userEvent.setup();
  const results = catalogResults(entries.slice(0, 2), [agent]);
  const props = {
    results,
    scope: "agent" as const,
    hasActiveAgent: true,
    onScope: jest.fn(),
    onBrowse: jest.fn(),
    onOpen: jest.fn(),
    pins: [] as string[],
    onPin: jest.fn(),
    opening: false,
    loading: false,
  };
  const view = render(<ArtifactShelf {...props} />);
  const open = screen.getByRole("button", { name: "Open Artifact 0 from One" });
  open.focus();
  await user.keyboard("{Enter}");
  expect(props.onOpen).toHaveBeenCalledWith(results[1]);
  await user.tab();
  const pin = screen.getByRole("button", { name: "Pin Artifact 0" });
  expect(pin).toHaveFocus();
  await user.keyboard(" ");
  const id = artifactIdentity(results[1]);
  expect(props.onPin).toHaveBeenCalledWith(id, true);
  view.rerender(
    <ArtifactShelf
      {...props}
      results={catalogResults(entries.slice(0, 2), [agent], { pins: [id] })}
      pins={[id]}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Unpin Artifact 0" }),
  ).toHaveFocus();
  expect(
    screen.getByRole("button", { name: "Unpin Artifact 0" }),
  ).toHaveAttribute("aria-pressed", "true");
  screen.getByRole("button", { name: "Browse all (2)" }).focus();
  await user.keyboard("{Enter}");
  expect(props.onBrowse).toHaveBeenCalledTimes(1);
});
