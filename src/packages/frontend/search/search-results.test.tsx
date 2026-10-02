import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fromJS } from "immutable";
import { SearchResults } from "./search-results";
import { closeSearch, getSearchState, openSearch } from "./search-store";

const openProject = jest.fn();
const fileSearch = jest.fn();
const contentSearch = jest.fn();
const snapshotSearch = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => {
  const { fromJS } = require("immutable");
  const projects = fromJS({
    p1: { title: "Thesis", last_edited: "2026-09-20" },
    p2: { title: "Plot lab", last_edited: "2026-09-21" },
  });
  return {
    redux: {
      getActions: () => ({
        open_project: (...a) => openProject(...a),
        setState: jest.fn(),
        set_active_tab: jest.fn(),
      }),
      getStore: () => ({ get: () => "me" }),
      getProjectActions: () => undefined,
    },
    useTypedRedux: (store: string, field: string) =>
      store === "projects"
        ? projects
        : field === "account_id"
          ? "me"
          : undefined,
  };
});
jest.mock("@cocalc/frontend/app-framework/project-runtime", () => ({
  ensureProjectReduxRuntime: async () => {},
}));
jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  TimeAgo: () => null,
}));
jest.mock("@cocalc/frontend/chat/search-hit-time", () => ({
  SearchHitTime: () => null,
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));
jest.mock("@cocalc/frontend/agents/artifact-catalog-store", () => ({
  sharedArtifactCatalog: () => ({
    get: () => ({ entries: [], loading: false }),
    subscribe: () => () => {},
  }),
  catalogResults: () => [],
}));
jest.mock("@cocalc/frontend/agents/artifact-names", () => ({
  useArtifactNames: () => ({ names: [] }),
}));
jest.mock("@cocalc/frontend/agents/message-search", () => ({}));
jest.mock("@cocalc/frontend/agents/search-runner", () => ({
  runAgentSearch: async () => ({
    hits: [],
    searched: 0,
    unavailable: 0,
    remaining: 0,
    limited: false,
    errors: [],
  }),
}));
jest.mock("@cocalc/frontend/people/collaborators", () => ({
  usePeople: () => [],
}));
const mockConversation = {
  conversation_id: "c1",
  project_id: "p1",
  title: "Weekly",
  last_activity: 1,
};
jest.mock("@cocalc/frontend/people/use-conversations", () => ({
  useConversations: () => ({
    conversations: [mockConversation],
    loading: false,
  }),
}));
const conversationSearch = jest.fn();
jest.mock("@cocalc/frontend/people/search-dialog", () => ({
  SEARCH_MAX_CONVERSATIONS: 50,
  searchConversations: (...a) => conversationSearch(...a),
}));
jest.mock("@cocalc/frontend/projects/project-aliases", () => ({
  useProjectAliases: () => new Map([["p1", "thesis"]]),
}));
jest.mock("@cocalc/frontend/projects/file-search-runner", () => ({
  ...jest.requireActual("@cocalc/frontend/projects/file-search-runner"),
  searchProjectFiles: (...a) => fileSearch(...a),
}));
jest.mock("./content-search", () => ({
  searchProjectContents: (...a) => contentSearch(...a),
  searchProjectSnapshots: (...a) => snapshotSearch(...a),
}));

const props = {
  accountId: "me",
  agents: [],
  activity: {},
  available: () => true,
  matchAgent: () => false,
  agentTitle: () => "",
  onOpenAgent: jest.fn(),
  onOpenMessage: jest.fn(),
  onOpenArtifact: jest.fn(),
};

afterEach(() => act(() => closeSearch()));

test("the starting page's kind comes first and expanded; host searches report coverage", async () => {
  fileSearch.mockResolvedValue({ paths: ["plots/a.png"], truncated: false });
  contentSearch.mockImplementation(async (project_id) => {
    if (project_id === "p1") throw Error("host down");
    return {
      items: [{ project_id, path: "x.py", line: 4, text: "plot(x)" }],
      truncated: false,
    };
  });
  act(() => openSearch("plot", "projects"));
  render(<SearchResults {...props} />);
  const headers = screen.getAllByRole("button", { expanded: true });
  expect(headers[0]).toHaveTextContent("Projects");
  // Instant: titles match.
  expect(
    screen.getByRole("button", { name: "Open project Plot lab" }),
  ).toBeInTheDocument();
  // Searched on the hosts: file names and contents, with coverage.
  expect(
    await screen.findByRole("button", { name: /Open plots\/a.png in Thesis/ }),
  ).toBeInTheDocument();
  expect(
    await screen.findByRole("button", { name: "Open x.py line 4 in Plot lab" }),
  ).toBeInTheDocument();
  expect(await screen.findByText(/1 unavailable/)).toBeInTheDocument();
  // Other kinds are collapsed below.
  expect(
    screen.getByRole("button", { name: /Agents/, expanded: false }),
  ).toBeInTheDocument();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Open project Plot lab" }));
  expect(openProject).toHaveBeenCalledWith({
    project_id: "p2",
    switch_to: true,
  });
  expect(getSearchState().open).toBe(false);
});

test("project aliases match", () => {
  act(() => openSearch("@thesis", "projects"));
  fileSearch.mockResolvedValue({ paths: [], truncated: false });
  contentSearch.mockResolvedValue({ items: [], truncated: false });
  render(<SearchResults {...props} />);
  const region = screen.getByRole("region", { name: "Search results" });
  expect(
    within(region).getByRole("button", { name: "Open project Thesis" }),
  ).toBeInTheDocument();
});

test("when file names and contents find nothing, the snapshots are searched", async () => {
  fileSearch.mockResolvedValue({ paths: [], truncated: false });
  contentSearch.mockResolvedValue({ items: [], truncated: false });
  snapshotSearch.mockImplementation(async (project_id) => ({
    items:
      project_id === "p1"
        ? [{ project_id, snapshot: "2026-09-01T10:00:00Z", path: "gone.tex" }]
        : [],
    truncated: false,
  }));
  act(() => openSearch("gone", "projects"));
  render(<SearchResults {...props} />);
  expect(
    await screen.findByRole("button", {
      name: "Open gone.tex from snapshot 2026-09-01T10:00:00Z in Thesis",
    }),
  ).toBeInTheDocument();
});

test("people searches message text in conversations", async () => {
  conversationSearch.mockImplementation(async ({ conversations, onProgress }) =>
    onProgress(
      [
        {
          conversation: conversations[0],
          hit: { row_id: 1, segment_id: "head", snippet: "the budget is due" },
        },
      ],
      1,
      0,
    ),
  );
  act(() => openSearch("budget", "people"));
  render(<SearchResults {...props} />);
  const hit = await screen.findByRole("button", {
    name: "Open message in Weekly",
  });
  expect(hit).toHaveTextContent("the budget is due");
  await userEvent.setup().click(hit);
  expect(getSearchState().open).toBe(false);
});
