import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Map, fromJS } from "immutable";
import userEvent from "@testing-library/user-event";
import { ScanFiles } from "./scan-projects";
import type { DirectoryApi } from "./workspace-api";
import { VirtuosoMockContext } from "react-virtuoso";
jest.mock("@cocalc/frontend/docs/link", () => ({
  DocsLink: ({ slug, children }: any) => (
    <a href={`/docs/${slug}`}>{children}</a>
  ),
}));
let mockHostInfo = Map<string, any>();
const mockEnsureHostInfo = jest.fn(async () => undefined);
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({ erase_active_key_handler: jest.fn() }) },
  useActions: () => ({ ensure_host_info: mockEnsureHostInfo }),
  useTypedRedux: () => mockHostInfo,
}));
const accountId = "account";
function setup() {
  let operation: any;
  let enabled = true;
  const projects = Array.from({ length: 30 }, (_, i) => ({
    host_id: "online-host",
    project_id: i === 0 ? "first" : `project-${i}`,
    title: i === 0 ? "First project" : `Project ${i}`,
    changed_since_scan: i === 0 || i === 2,
  }));
  const scanProjects = jest.fn(async (request: any) => {
    if (request.action === "projects")
      return {
        enabled,
        total: 30,
        projects: enabled
          ? request.after
            ? projects.slice(25)
            : projects.slice(0, 25)
          : [],
        next: enabled && !request.after ? "cursor" : undefined,
      };
    if (request.action === "start")
      operation = {
        op_id: "batch",
        status: "running",
        cancelling: false,
        total: request.project_ids === "all" ? 30 : request.project_ids.length,
        processed: 0,
        counts: {},
        children: [],
        next_eligible_at: 0,
      };
    if (request.action === "cancel")
      operation = { ...operation, cancelling: true };
    return { enabled, operation };
  });
  const api = { scanProjects } as unknown as DirectoryApi;
  return {
    scanProjects,
    projects,
    api,
    user: userEvent.setup(),
    render: () =>
      render(
        <VirtuosoMockContext.Provider
          value={{ viewportHeight: 288, itemHeight: 44 }}
        >
          <ScanFiles api={api} accountId={accountId} />
        </VirtuosoMockContext.Provider>,
      ),
    setOperation: (value: any) => {
      operation = value;
    },
    finish: (project_id = "first", title?: string) => {
      operation = {
        op_id: "batch",
        status: "succeeded",
        cancelling: false,
        total: 1,
        processed: 1,
        counts: { successful: 1 },
        children: [
          {
            project_id,
            title,
            state: "successful",
            entries: 8,
            candidates: 1,
          },
        ],
        next_eligible_at: 0,
      };
    },
    disable: () => {
      enabled = false;
    },
  };
}
beforeEach(() => {
  sessionStorage.clear();
  mockEnsureHostInfo.mockClear();
  mockHostInfo = Map({
    "online-host": fromJS({ status: "running", online: true, ready: true }),
  });
});
test("keyboard selection starts a fixed all-project batch and returning only observes", async () => {
  const f = setup();
  const first = f.render();
  await f.user.tab();
  await f.user.tab();
  expect(
    screen.getByRole("textbox", { name: "Search projects" }),
  ).toHaveFocus();
  const all = await screen.findByRole("checkbox", {
    name: "Select all eligible projects (30)",
  });
  await waitFor(() => expect(all).toBeEnabled());
  act(() => all.focus());
  await f.user.keyboard(" ");
  const start = screen.getByRole("button", { name: "Start scan" });
  start.focus();
  await f.user.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("0 of 30"),
  );
  expect(
    f.scanProjects.mock.calls.find(([r]) => r.action === "start")![0]
      .project_ids,
  ).toEqual(f.projects.map((project) => project.project_id));
  first.unmount();
  f.render();
  await screen.findByRole("status");
  expect(
    f.scanProjects.mock.calls.filter(([r]) => r.action === "start"),
  ).toHaveLength(1);
});
test("disabled admission keeps cancellation and status inspectable", async () => {
  const f = setup();
  f.render();
  await f.user.click(
    await screen.findByRole("checkbox", { name: "First project" }),
  );
  await f.user.click(screen.getByRole("button", { name: "Start scan" }));
  await screen.findByRole("status");
  f.disable();
  await f.user.click(
    screen.getByRole("button", { name: "Refresh scan status" }),
  );
  await waitFor(() =>
    expect(screen.getByText(/New scans are disabled/)).toBeInTheDocument(),
  );
  const cancel = screen.getByRole("button", { name: "Cancel scan" });
  cancel.focus();
  await f.user.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Cancelling"),
  );
  expect(screen.getByRole("button", { name: "Start scan" })).toBeDisabled();
});
test("a lost submission is recovered without resubmitting on reopen", async () => {
  const f = setup();
  const first = f.render();
  await f.user.click(
    await screen.findByRole("checkbox", { name: "First project" }),
  );
  f.scanProjects.mockRejectedValueOnce(Error("timeout"));
  await f.user.click(screen.getByRole("button", { name: "Start scan" }));
  await screen.findByRole("alert");
  const saved = JSON.parse(
    sessionStorage.getItem("people-scan-batch:account")!,
  );
  first.unmount();
  f.render();
  const retry = await screen.findByRole("button", {
    name: "Retry same scan request",
  });
  await waitFor(() => expect(retry).toBeEnabled());
  await f.user.click(retry);
  await screen.findByRole("status");
  const starts = f.scanProjects.mock.calls.filter(
    ([r]) => r.action === "start",
  );
  expect(starts.map(([r]) => r.request_id)).toEqual([
    saved.request_id,
    saved.request_id,
  ]);
});

test("opening and searching only observe; completed details are collapsed and keyboard reachable", async () => {
  const f = setup();
  f.finish();
  f.render();
  await screen.findByRole("status");
  expect(screen.getByRole("status")).toHaveTextContent("Scan finished");
  const details = screen.getByText("Scan details").closest("details")!;
  expect(details).not.toHaveAttribute("open");
  const summary = screen.getByText("Scan details");
  summary.focus();
  expect(summary).toHaveFocus();
  // JSDOM does not implement the native Enter toggle; click exercises the
  // native disclosure without adding a second custom keyboard handler.
  await f.user.click(summary);
  expect(details).toHaveAttribute("open");
  expect(
    screen.getByRole("list", { name: "Project scan results" }),
  ).toHaveTextContent("First project");
  const search = screen.getByRole("textbox", { name: "Search projects" });
  await waitFor(() =>
    expect(screen.queryByText("Loading projects…")).not.toBeInTheDocument(),
  );
  const count = f.scanProjects.mock.calls.filter(
    ([r]) => r.action === "projects",
  ).length;
  await f.user.type(search, "First");
  await waitFor(() =>
    expect(
      screen.queryByRole("checkbox", { name: "Project 1", exact: true }),
    ).not.toBeInTheDocument(),
  );
  expect(
    f.scanProjects.mock.calls.filter(([r]) => r.action === "projects"),
  ).toHaveLength(count);
  expect(
    f.scanProjects.mock.calls.filter(([r]) => r.action === "start"),
  ).toEqual([]);
});

test.each([
  ["A project outside the picker page", "A project outside the picker page"],
  [undefined, "Untitled project"],
])(
  "scan details use server titles without visiting picker pages: %s",
  async (title, label) => {
    const f = setup();
    f.finish("unseen-project-id", title);
    f.render();
    await screen.findByRole("status");
    await f.user.click(screen.getByText("Scan details"));
    const results = screen.getByRole("list", { name: "Project scan results" });
    expect(results).toHaveTextContent(label!);
    expect(results).not.toHaveTextContent("unseen-project-id");
  },
);

test("continuous picker loads all pages, filters locally and selects changed projects in one click", async () => {
  const f = setup();
  f.render();
  const changed = await screen.findByRole("button", {
    name: "Changed since last scan (2)",
  });
  await waitFor(() => expect(changed).toBeEnabled());
  expect(screen.queryByRole("button", { name: /project page/i })).toBeNull();
  expect(
    screen.getByRole("link", { name: "How indexing and manual scans work" }),
  ).toHaveAttribute("href", "/docs/collaboration/scan-files");
  await f.user.type(
    screen.getByRole("textbox", { name: "Search projects" }),
    "First",
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("checkbox", { name: "Project 2", exact: true }),
    ).toBeNull(),
  );
  act(() => changed.focus());
  await f.user.keyboard("{Enter}");
  await f.user.click(screen.getByRole("button", { name: "Start scan" }));
  expect(
    f.scanProjects.mock.calls.find(([r]) => r.action === "start")![0]
      .project_ids,
  ).toEqual(["first", "project-2"]);
});

test("checkbox ranges select and clear in filtered order and keep off-filter selections", async () => {
  const f = setup();
  f.render();
  const first = await screen.findByRole("checkbox", { name: "First project" });
  await waitFor(() => expect(first).toBeEnabled());
  fireEvent.click(first);
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Project 3", exact: true }),
    { shiftKey: true },
  );
  expect(
    screen.getByRole("checkbox", { name: "Project 2", exact: true }),
  ).toBeChecked();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Project 1", exact: true }),
    { shiftKey: true },
  );
  expect(
    screen.getByRole("checkbox", { name: "Project 2", exact: true }),
  ).not.toBeChecked();
  expect(first).toBeChecked();
  await f.user.type(
    screen.getByRole("textbox", { name: "Search projects" }),
    "Project 2",
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("checkbox", { name: "First project" }),
    ).toBeNull(),
  );
  const second = screen.getByRole("checkbox", {
    name: "Project 2",
    exact: true,
  });
  act(() => second.focus());
  await f.user.keyboard(" ");
  expect(second).toBeChecked();
  await f.user.click(screen.getByRole("button", { name: "Start scan" }));
  expect(
    f.scanProjects.mock.calls.find(([r]) => r.action === "start")![0]
      .project_ids,
  ).toEqual(["first", "project-2"]);
});

test("mixed canceled and unavailable results count scans honestly and use a neutral bar", async () => {
  const f = setup();
  f.setOperation({
    op_id: "batch",
    status: "failed",
    cancelling: false,
    total: 72,
    processed: 72,
    counts: { unavailable: 27, cancelled: 44, deferred: 1 },
    children: [],
    next_eligible_at: 0,
  });
  const { container } = f.render();
  await screen.findByRole("heading", { name: "Scan ended after cancellation" });
  expect(screen.getByRole("status")).toHaveTextContent(
    "0 of 72 projects scanned",
  );
  expect(container.querySelector(".ant-progress-status-exception")).toBeNull();
});

test("only offers fully online hosts and submits the visible eligible set", async () => {
  const f = setup();
  f.projects[0].host_id = "offline-host";
  f.projects[1].host_id = "starting-host";
  f.projects[2].host_id = "deprovisioned-host";
  f.projects[3].host_id = "unready-host";
  mockHostInfo = mockHostInfo.merge(
    fromJS({
      "offline-host": { status: "running", online: false, ready: true },
      "starting-host": { status: "starting", online: true, ready: true },
      "deprovisioned-host": {
        status: "deprovisioned",
        online: false,
        ready: false,
      },
      "unready-host": { status: "running", online: true, ready: false },
    }),
  );
  f.render();
  const all = await screen.findByRole("checkbox", {
    name: "Select all eligible projects (26)",
  });
  await waitFor(() => expect(all).toBeEnabled());
  expect(screen.queryByRole("checkbox", { name: "First project" })).toBeNull();
  await f.user.click(all);
  await f.user.click(screen.getByRole("button", { name: "Start scan" }));
  await waitFor(() =>
    expect(f.scanProjects.mock.calls.some(([r]) => r.action === "start")).toBe(
      true,
    ),
  );
  expect(
    f.scanProjects.mock.calls.find(([r]) => r.action === "start")![0]
      .project_ids,
  ).toEqual(f.projects.slice(4).map((project) => project.project_id));
  expect(mockEnsureHostInfo.mock.calls.map(([host]) => host).sort()).toEqual(
    [
      "online-host",
      "offline-host",
      "starting-host",
      "deprovisioned-host",
      "unready-host",
    ].sort(),
  );
});

test("an unrelated pending host lookup does not delay an online project scan", async () => {
  const f = setup();
  f.projects[1].host_id = "slow-host";
  mockEnsureHostInfo
    .mockImplementationOnce(async () => undefined)
    .mockImplementationOnce(() => new Promise(() => {}));
  f.render();
  const choice = await screen.findByRole("checkbox", { name: "First project" });
  await f.user.click(choice);
  const start = screen.getByRole("button", { name: "Start scan" });
  await waitFor(() => expect(start).toBeEnabled());
  start.focus();
  await f.user.keyboard("{Enter}");
  await waitFor(() =>
    expect(f.scanProjects.mock.calls.some(([r]) => r.action === "start")).toBe(
      true,
    ),
  );
});

test("partial indexing reports file counts and identity errors rather than directory entries", async () => {
  const f = setup();
  f.setOperation({
    op_id: "batch",
    status: "failed",
    cancelling: false,
    total: 1,
    processed: 1,
    counts: { truncated: 1 },
    next_eligible_at: 0,
    children: [
      {
        project_id: "first",
        title: "First project",
        state: "truncated",
        entries: 0,
        candidates: 36,
        indexed: 33,
        last_success: 1000,
        last_fail: 2000,
        message:
          "3 chat files could not be indexed. Previously indexed results were kept.",
        source_issues: [
          { chat_path: "/home/user/copy.chat", reason: "identity_conflict" },
        ],
      },
    ],
  });
  f.render();
  await screen.findByRole("heading", { name: "Scan finished with exceptions" });
  const details = screen.getByText("Scan details");
  details.focus();
  await f.user.keyboard("{Enter}");
  expect(screen.getByText(/33 of 36 chat files indexed/)).toBeInTheDocument();
  expect(screen.queryByText(/entries examined/)).not.toBeInTheDocument();
  expect(screen.getByText(/Last successful scan:/)).toHaveTextContent(
    "Last failed scan:",
  );
  expect(screen.getByText(/Last successful scan:/)).toHaveTextContent(
    "Changes since the last successful scan will be retried.",
  );
  expect(
    screen.getByRole("list", { name: "Files needing attention" }),
  ).toHaveTextContent("/home/user/copy.chat");
  expect(
    screen.getByText(/Duplicate or copied conversation identity/),
  ).toBeInTheDocument();
});
