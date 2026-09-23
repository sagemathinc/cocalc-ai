/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { EventEmitter } from "events";
import { fromJS } from "immutable";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { artifactKey } from "@cocalc/chat";
import type { ArtifactRecord } from "@cocalc/chat";
import { LibraryArtifactView } from "./library-artifact-view";
import ForeignArtifactSource, {
  FOREIGN_ARTIFACT_CONVERSATION_EVENT,
} from "@cocalc/frontend/frame-editors/chat-editor/foreign-artifact-source";
import type { ForeignArtifactTarget } from "@cocalc/frontend/frame-editors/chat-editor/foreign-artifact-source";
import { useFileContext } from "@cocalc/frontend/lib/file-context";

const mockOpen = jest.fn();
const mockCopy = jest.fn();
jest.mock("@cocalc/frontend/components/copy-to-clipboard-util", () => ({
  copyTextToClipboard: (options) => mockCopy(options),
}));
const mockStat = jest.fn();
const mockReadFile = jest.fn();
const mockProject = {
  open_file: mockOpen,
  fs: () => ({ stat: mockStat, readFile: mockReadFile }),
};
const mockGetProject = jest.fn(() => mockProject);
const mockContextOptions = jest.fn();
let mockAllowed = true;
let mockReadOnly = false;
let mockActions: any;
let db: any;
let record: ArtifactRecord | undefined;

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getProjectActions: (id) => mockGetProject(id),
    getEditorActions: () => mockActions,
    getActions: () => undefined,
  },
  useTypedRedux: () => undefined,
}));
jest.mock("@cocalc/frontend/app-framework/project-runtime", () => ({
  ensureProjectReduxRuntime: jest.fn(),
}));
jest.mock("@cocalc/frontend/project/context", () => ({
  ProjectContext: require("react").createContext({}),
  useProjectContext: () =>
    require("react").useContext(
      require("@cocalc/frontend/project/context").ProjectContext,
    ),
  useProjectContextProvider: (options) => {
    mockContextOptions(options);
    return {
      project_id: options.project_id,
      actions: mockProject,
      projectAccess: {
        role: "collaborator",
        capabilities: { useProjectRuntime: mockAllowed },
      },
    };
  },
}));
jest.mock("@cocalc/frontend/project/page/anchor-tag-component", () => ({
  __esModule: true,
  default: () => undefined,
}));
jest.mock("@cocalc/frontend/project/page/url-transform", () => ({
  __esModule: true,
  default:
    ({ project_id, path }) =>
    (url) =>
      `${project_id}:${path}:${url}`,
}));
jest.mock("@cocalc/frontend/chat/artifacts", () => ({
  artifactSyncdbReady: (db) => db?.get_state() === "ready",
  useArtifactChanges: (db) => {
    const [, refresh] = require("react").useState(0);
    require("react").useEffect(() => {
      const change = () => refresh((n) => n + 1);
      db?.on("change", change);
      return () => db?.removeListener("change", change);
    }, [db]);
  },
}));

function MarkdownProbe({ value }) {
  const context = useFileContext();
  return (
    <div>
      {value}
      <output aria-label="Markdown source context">
        {JSON.stringify({
          project: context.project_id,
          path: context.path,
          sanitized: context.noSanitize === false,
          codebarDisabled: context.disableMarkdownCodebar,
          image: context.urlTransform?.("image.png", "img"),
          link: context.urlTransform?.("notes.md", "a"),
        })}
      </output>
    </div>
  );
}
jest.mock("@cocalc/frontend/editors/slate/static-markdown", () => ({
  __esModule: true,
  default: (props) => <MarkdownProbe {...props} />,
}));
// Keep the source loader, record validation, and file renderer real. Mock only
// heavyweight content viewers and the other renderer boundaries.
jest.mock("@cocalc/frontend/public-viewer/file-contents", () => ({
  __esModule: true,
  default: ({ content }) => <div>{content}</div>,
}));
jest.mock("@cocalc/frontend/project/use-project-host-authed-url", () => ({
  useProjectHostAuthedUrl: ({ url }) => url,
}));
jest.mock("@cocalc/frontend/project/viewer-file-editor", () => ({
  viewerRawFileUrl: () => "",
}));
jest.mock("@cocalc/frontend/chat/contextual-reply", () => ({
  LocalCommentButton: () => null,
}));
const mockCommit = jest.fn(() => <div>Commit renderer</div>);
const mockPR = jest.fn(() => <div>PR renderer</div>);
const mockActionsRenderer = jest.fn(() => <div>Actions renderer</div>);
jest.mock("@cocalc/frontend/frame-editors/chat-editor/commit-artifact", () => ({
  CommitArtifact: (props) => mockCommit(props),
}));
jest.mock(
  "@cocalc/frontend/frame-editors/chat-editor/github-pr-artifact",
  () => ({
    GitHubPRArtifact: (props) => mockPR(props),
  }),
);
jest.mock(
  "@cocalc/frontend/frame-editors/chat-editor/action-list-artifact",
  () => ({
    ActionListArtifact: (props) => mockActionsRenderer(props),
  }),
);

const target: ForeignArtifactTarget = {
  projectId: "source-project",
  path: "/chats/source.chat",
  threadId: "source-thread",
  artifactId: "shared-id",
};
function sourceRecord(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    ...artifactKey({
      thread_id: target.threadId,
      artifact_id: target.artifactId,
    }),
    artifact_id: target.artifactId,
    schema_version: 1,
    kind: "markdown",
    title: "Actual source title",
    input: "Actual source content",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOpen.mockReset().mockResolvedValue(undefined);
  mockCopy.mockReset().mockResolvedValue(true);
  mockStat.mockReset().mockResolvedValue({ size: 12 });
  mockReadFile.mockReset().mockResolvedValue("Saved source file");
  mockAllowed = true;
  mockReadOnly = false;
  record = sourceRecord();
  db = Object.assign(new EventEmitter(), {
    get_state: () => "ready",
    get_doc: () => ({}),
    is_read_only: () => false,
    get_one: jest.fn(() => record && fromJS(record)),
    set: jest.fn(),
    commit: jest.fn(),
    save: jest.fn(),
  });
  mockActions = {
    isClosed: () => false,
    getArtifactSyncdb: () => db,
    store: Object.assign(new EventEmitter(), { get: () => mockReadOnly }),
  };
});

test("loads the real source without an agent, preserves focus, and delegates explicit navigation", async () => {
  const onBack = jest.fn();
  const onShowConversation = jest.fn();
  const event = jest.fn();
  window.addEventListener(FOREIGN_ARTIFACT_CONVERSATION_EVENT, event);
  const user = userEvent.setup();
  render(<LibraryArtifactView {...{ target, onBack, onShowConversation }} />);
  expect(
    screen.getByRole("group", { name: "Library artifact navigation" }),
  ).toHaveFocus();
  const back = screen.getByRole("button", { name: "Back to Library" });
  back.focus();
  await screen.findByRole("heading", { name: "Actual source title", level: 1 });
  expect(back).toHaveFocus();
  expect(
    within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole(
      "heading",
    ),
  ).toHaveAttribute("aria-current", "page");
  expect(
    screen.getByRole("document", { name: "Artifact document" }),
  ).toHaveTextContent("Actual source content");
  expect(mockGetProject).toHaveBeenCalledWith(target.projectId);
  expect(mockOpen).toHaveBeenCalledTimes(1);
  expect(mockOpen).toHaveBeenCalledWith({
    path: target.path,
    embedded: true,
    foreground: false,
    foreground_project: false,
    change_history: false,
    wait_for_ready: true,
  });
  expect(mockContextOptions).toHaveBeenCalledWith(
    expect.objectContaining({
      project_id: target.projectId,
      is_active: false,
      manageWorkspaceSelection: false,
    }),
  );
  expect(db.get_one).toHaveBeenCalledWith(
    artifactKey({
      thread_id: target.threadId,
      artifact_id: target.artifactId,
    }),
  );
  expect(
    screen.queryByText(/belongs to another conversation/),
  ).not.toBeInTheDocument();
  expect(onShowConversation).not.toHaveBeenCalled();
  expect(event).not.toHaveBeenCalled();
  await user.tab();
  expect(
    screen.getByRole("button", { name: "Open source conversation" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onShowConversation).toHaveBeenCalledWith(target);
  await user.tab();
  expect(screen.getByRole("button", { name: "Copy link" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("document")).toHaveFocus();
  await user.tab({ shift: true });
  await user.tab({ shift: true });
  await user.tab({ shift: true });
  expect(back).toHaveFocus();
  await user.keyboard(" ");
  expect(onBack).toHaveBeenCalledTimes(1);
  expect(db.set).not.toHaveBeenCalled();
  expect(mockOpen).toHaveBeenCalledTimes(1);
  window.removeEventListener(FOREIGN_ARTIFACT_CONVERSATION_EVENT, event);
});

test("parent navigation remains keyboard accessible while loading, updating, and missing an agentless source", async () => {
  db.get_state = () => "init";
  const toggle = jest.fn();
  const user = userEvent.setup();
  render(
    <LibraryArtifactView
      target={target}
      onBack={() => {}}
      navigation={<button onClick={toggle}>Show sidebar</button>}
    />,
  );
  expect(screen.getByText("Loading artifact source...")).toBeVisible();
  expect(
    screen.getByRole("group", { name: "Library artifact navigation" }),
  ).toHaveFocus();
  const navigation = screen.getByRole("button", { name: "Show sidebar" });
  expect(
    screen.getByRole("navigation", { name: "Breadcrumb" }),
  ).not.toContainElement(navigation);
  await user.tab();
  expect(navigation).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(toggle).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(db.listenerCount("ready")).toBeGreaterThan(0));
  act(() => {
    db.get_state = () => "ready";
    db.emit("ready");
  });
  await screen.findByRole("heading", { name: "Actual source title" });
  expect(navigation).toHaveFocus();
  act(() => {
    record = sourceRecord({ title: "Latest title" });
    db.emit("change");
  });
  expect(screen.getByRole("heading", { name: "Latest title" })).toBeVisible();
  expect(navigation).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Back to Library" })).toHaveFocus();
  await user.tab({ shift: true });
  act(() => {
    record = undefined;
    db.emit("change");
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Artifact unavailable");
  expect(navigation).toHaveFocus();
  await user.keyboard(" ");
  expect(toggle).toHaveBeenCalledTimes(2);
  expect(mockOpen).toHaveBeenCalledTimes(1);
});

test("uses sanitized source context and follows live title/content updates, not publication metadata", async () => {
  render(
    <LibraryArtifactView
      target={{ ...target, publicationId: "old-publication" }}
      onBack={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "Actual source title" });
  expect(screen.getByLabelText("Markdown source context")).toHaveTextContent(
    JSON.stringify({
      project: target.projectId,
      path: target.path,
      sanitized: true,
      codebarDisabled: true,
      image: "",
      link: `${target.projectId}:${target.path}:notes.md`,
    }),
  );
  act(() => {
    record = sourceRecord({
      title: "New source title",
      theme: { title: "Authored title" },
      input: "Updated source content",
    });
    db.emit("change");
  });
  expect(screen.getByRole("heading", { name: "Authored title" })).toBeVisible();
  expect(screen.getByRole("document")).toHaveTextContent(
    "Updated source content",
  );
  expect(
    screen.queryByRole("button", { name: "Open source conversation" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Open in project" }),
  ).not.toBeInTheDocument();
});

test("Copy link reads the parent's current URL at activation and reports clipboard failures", async () => {
  const user = userEvent.setup();
  render(<LibraryArtifactView target={target} onBack={() => {}} />);
  await screen.findByRole("heading", { name: "Actual source title" });
  const originalUrl = window.location.href;
  try {
    window.history.replaceState(
      null,
      "",
      "/library/source-project/stable-entry",
    );
    const copy = screen.getByRole("button", { name: "Copy link" });
    copy.focus();
    await user.keyboard("{Enter}");
    expect(mockCopy).toHaveBeenLastCalledWith({ text: window.location.href });
    expect(screen.getByText("Link copied")).toHaveAttribute("role", "status");
    expect(copy).toHaveFocus();
    mockCopy.mockResolvedValueOnce(false);
    await user.keyboard(" ");
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to copy link");
    expect(screen.queryByText("Link copied")).not.toBeInTheDocument();
    expect(copy).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Link copied")).toHaveAttribute("role", "status");
    expect(mockOpen).toHaveBeenCalledTimes(1);
  } finally {
    window.history.replaceState(null, "", originalUrl);
  }
});

test("name control saves an account alias through a keyboard-accessible dialog", async () => {
  const user = userEvent.setup();
  const onName = jest.fn().mockResolvedValue(undefined);
  render(
    <LibraryArtifactView target={target} onBack={() => {}} onName={onName} />,
  );
  await user.click(screen.getByRole("button", { name: "Name artifact" }));
  const dialog = screen.getByRole("dialog", { name: "Name artifact" });
  const input = within(dialog).getByRole("textbox", { name: "Artifact name" });
  await user.type(input, "NB1");
  await user.click(within(dialog).getByRole("button", { name: "Save name" }));
  await waitFor(() => expect(onName).toHaveBeenCalledWith("nb1"));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Name artifact" })).toBeNull(),
  );
});

test.each(["throw", "reject"])(
  "source navigation handles %s and allows keyboard retry without selecting an agent",
  async (failure) => {
    const onShowConversation = jest
      .fn()
      .mockImplementationOnce(() => {
        if (failure === "throw") throw Error("Conversation unavailable");
        return Promise.reject(Error("Conversation unavailable"));
      })
      .mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <LibraryArtifactView
        target={target}
        onBack={() => {}}
        onShowConversation={onShowConversation}
      />,
    );
    await screen.findByRole("heading", { name: "Actual source title" });
    const open = within(
      screen.getByRole("group", { name: "Library artifact navigation" }),
    ).getByRole("button", { name: "Open source conversation" });
    open.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to open source conversation: Error: Conversation unavailable",
    );
    expect(open).toBeEnabled();
    expect(open).toHaveFocus();
    expect(onShowConversation).toHaveBeenCalledWith(target);
    await user.keyboard(" ");
    expect(onShowConversation).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mockOpen).toHaveBeenCalledTimes(1);
  },
);

test("source navigation prevents duplicate activation while its promise is pending", async () => {
  let finish!: () => void;
  const onShowConversation = jest.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const user = userEvent.setup();
  render(
    <LibraryArtifactView
      target={target}
      onBack={() => {}}
      onShowConversation={onShowConversation}
    />,
  );
  await screen.findByRole("heading", { name: "Actual source title" });
  const open = screen.getByRole("button", { name: "Open source conversation" });
  await user.click(open);
  expect(open).toBeDisabled();
  await user.click(open);
  expect(onShowConversation).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(open).toBeEnabled();
});

test("Open in project uses the associated file in the source project, not the chat", async () => {
  record = sourceRecord({ kind: "file", file: { path: "reports/result.txt" } });
  render(<LibraryArtifactView target={target} onBack={() => {}} />);
  expect(
    await screen.findByRole("document", { name: "File preview" }),
  ).toBeVisible();
  await screen.findByText("Saved source file");
  expect(mockReadFile).toHaveBeenCalledWith("reports/result.txt", "utf8");
  const open = screen.getByRole("button", { name: "Open in project" });
  open.focus();
  await userEvent.setup().keyboard("{Enter}");
  expect(open).toHaveFocus();
  expect(mockOpen).toHaveBeenLastCalledWith({ path: "reports/result.txt" });
  expect(screen.getByRole("button", { name: "Comment" })).toBeDisabled();
  act(() => {
    record = sourceRecord({ kind: "file", file: { path: "reports/new.txt" } });
    db.emit("change");
  });
  await waitFor(() =>
    expect(mockReadFile).toHaveBeenCalledWith("reports/new.txt", "utf8"),
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Open in project" }));
  expect(mockOpen).toHaveBeenLastCalledWith({ path: "reports/new.txt" });
});

test.each(["commit", "github-pr", "actions"] as const)(
  "renders %s with source permissions and no agent/review callbacks",
  async (kind) => {
    mockReadOnly = true;
    record = sourceRecord({
      kind,
      commit: {
        sha: "a".repeat(40),
        path: "/repo",
        common_directory: "/repo/.git",
      },
      github_pr: {
        repository: "org/repo",
        number: 1,
        state: "open",
        draft: false,
        fetched_at: "2026-09-23T00:00:00Z",
        base_sha: "a".repeat(40),
        head_sha: "b".repeat(40),
        checks: "unknown",
      },
      actions: [
        { id: "a", title: "Proposed", target: "target", draft: "draft" },
      ],
    });
    render(<LibraryArtifactView target={target} onBack={() => {}} />);
    await screen.findByRole("heading", { name: "Actual source title" });
    const renderer =
      kind === "commit"
        ? mockCommit
        : kind === "github-pr"
          ? mockPR
          : mockActionsRenderer;
    const props = renderer.mock.calls.at(-1)![0] as any;
    expect(props.artifact).toMatchObject({
      kind,
      thread_id: target.threadId,
      artifact_id: target.artifactId,
    });
    expect(props.onReview).toBeUndefined();
    expect(props.onRequestAgentTurn).toBeUndefined();
    expect(props.storageKey).toBeUndefined();
    if (kind !== "actions") {
      expect(props).toMatchObject({
        projectId: target.projectId,
        sourcePath: target.path,
        readOnly: true,
      });
      act(() => {
        mockReadOnly = false;
        mockActions.store.emit("change");
      });
      expect((renderer.mock.calls.at(-1)![0] as any).readOnly).toBe(false);
    }
  },
);

test("missing/deleted records never manufacture an artifact and keep Back available", async () => {
  const onBack = jest.fn();
  render(<LibraryArtifactView target={target} onBack={onBack} />);
  await screen.findByRole("heading", { name: "Actual source title" });
  act(() => {
    record = undefined;
    db.emit("change");
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Artifact unavailable");
  expect(screen.queryByRole("document")).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Artifact" })).toBeVisible();
  const back = screen.getByRole("button", { name: "Back to Library" });
  back.focus();
  await userEvent.setup().keyboard("{Enter}");
  expect(onBack).toHaveBeenCalledTimes(1);
  expect(db.set).not.toHaveBeenCalled();
});

test("source access denial and failed loading expose Retry without selecting or inventing content", async () => {
  mockAllowed = false;
  const view = render(
    <LibraryArtifactView target={target} onBack={() => {}} />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Source project access is unavailable",
  );
  expect(mockOpen).not.toHaveBeenCalled();
  mockAllowed = true;
  mockStat.mockRejectedValueOnce(Error("Source chat missing"));
  view.rerender(<LibraryArtifactView target={target} onBack={() => {}} />);
  await screen.findByText(/Source chat missing/);
  expect(mockOpen).not.toHaveBeenCalled();
  const retry = screen.getByRole("button", { name: "Retry" });
  retry.focus();
  await userEvent.setup().keyboard("{Enter}");
  await screen.findByRole("heading", { name: "Actual source title" });
});

test("late agent discovery does not reload the resource or steal focus", async () => {
  const view = render(
    <LibraryArtifactView target={target} onBack={() => {}} />,
  );
  await screen.findByRole("heading", { name: "Actual source title" });
  const back = screen.getByRole("button", { name: "Back to Library" });
  back.focus();
  view.rerender(
    <LibraryArtifactView
      target={{ ...target, agentId: "discovered" }}
      onBack={() => {}}
    />,
  );
  expect(back).toHaveFocus();
  expect(mockOpen).toHaveBeenCalledTimes(1);
});

test("target change clears prior content while the new source loads", async () => {
  const view = render(
    <LibraryArtifactView target={target} onBack={() => {}} />,
  );
  await screen.findByRole("heading", { name: "Actual source title" });
  let finish!: () => void;
  mockStat.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const next = {
    ...target,
    projectId: "next-project",
    path: "/next.chat",
    threadId: "next-thread",
  };
  record = sourceRecord({
    ...artifactKey({ thread_id: next.threadId, artifact_id: next.artifactId }),
    title: "Next title",
  });
  view.rerender(<LibraryArtifactView target={next} onBack={() => {}} />);
  expect(
    screen.getByRole("group", { name: "Library artifact navigation" }),
  ).toHaveFocus();
  expect(screen.queryByText("Actual source title")).not.toBeInTheDocument();
  expect(screen.queryByRole("document")).not.toBeInTheDocument();
  await waitFor(() => expect(finish).toBeDefined());
  await act(async () => finish());
  await screen.findByRole("heading", { name: "Next title" });
  expect(db.get_one).toHaveBeenLastCalledWith(
    artifactKey({ thread_id: next.threadId, artifact_id: next.artifactId }),
  );
  expect(mockGetProject).toHaveBeenLastCalledWith("next-project");
});

test("the source loader retains the legacy warning by default", async () => {
  render(
    <ForeignArtifactSource target={target}>
      {() => <div>Loaded</div>}
    </ForeignArtifactSource>,
  );
  await screen.findByText("Loaded");
  expect(screen.getByRole("note")).toHaveTextContent(
    "belongs to another conversation",
  );
  expect(
    screen.getByRole("button", { name: "Show in conversation" }),
  ).toBeEnabled();
});
