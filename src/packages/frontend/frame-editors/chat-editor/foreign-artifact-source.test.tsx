import { EventEmitter } from "events";
import { useContext } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ForeignArtifactSource, {
  FOREIGN_ARTIFACT_CONVERSATION_EVENT,
  waitForArtifactSourceReady,
} from "./foreign-artifact-source";
import { ProjectContext } from "@cocalc/frontend/project/context";
import { useFileContext } from "@cocalc/frontend/lib/file-context";

const mockOpen = jest.fn();
let mockActions: any;
let mockReadOnly = false;
let mockAllowed = true;
let mockComponent: any;
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getProjectActions: () => ({
      open_file: mockOpen,
      fs: () => ({ stat: jest.fn().mockResolvedValue({}) }),
    }),
    getEditorActions: () => mockActions,
    getActions: () => mockActions,
    getStore: () => mockActions?.store,
  },
  useTypedRedux: () => ({ getIn: () => mockComponent }),
}));
jest.mock("@cocalc/frontend/app-framework/project-runtime", () => ({
  ensureProjectReduxRuntime: jest.fn(),
}));
jest.mock("@cocalc/frontend/project/context", () => ({
  ProjectContext: require("react").createContext({}),
  useProjectContextProvider: ({ project_id }) => ({
    project_id,
    actions: { fs: () => "source filesystem" },
    projectAccess: {
      role: "collaborator",
      capabilities: { useProjectRuntime: mockAllowed },
    },
  }),
}));
jest.mock("@cocalc/frontend/project/page/anchor-tag-component", () => ({
  __esModule: true,
  default: () => undefined,
}));
jest.mock("@cocalc/frontend/project/page/url-transform", () => ({
  __esModule: true,
  default: () => undefined,
}));
jest.mock("@cocalc/frontend/chat/artifacts", () => ({
  artifactSyncdbReady: (db) => db?.get_state() === "ready",
  useArtifactChanges: (db) => {
    const [n, setN] = require("react").useState(0);
    require("react").useEffect(() => {
      const update = () => setN((n) => n + 1);
      db?.on("closed", update);
      return () => db?.removeListener("closed", update);
    }, [db]);
    return n;
  },
}));

const target = {
  projectId: "source",
  path: "/source.chat",
  threadId: "other-thread",
  artifactId: "same-id",
  agentId: "source-agent",
  publicationId: "publication",
};
let db: any;
beforeEach(() => {
  mockOpen.mockReset().mockResolvedValue(undefined);
  mockReadOnly = false;
  mockAllowed = true;
  mockComponent = {
    Editor: () => null,
    redux_name: "source-editor",
    runtime_generation: 1,
  };
  db = Object.assign(new EventEmitter(), {
    get_state: () => "ready",
    is_read_only: () => false,
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

test("cold editor remains loading until syncdb has a real document", async () => {
  db.get_state = () => "init";
  db.get_doc = () => {
    throw Error("doc must be set");
  };
  render(view());
  await waitFor(() => expect(db.listenerCount("ready")).toBe(1));
  expect(screen.getByText("Loading artifact source...")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  act(() => {
    db.get_state = () => "ready";
    db.emit("ready");
  });
  expect(screen.queryByRole("button", { name: "Edit source" })).toBeNull();
  act(() => {
    db.get_doc = () => ({});
    db.emit("change");
  });
  await screen.findByRole("button", { name: "Edit source" });
});

test.each(["close", "closed", "error", "abort", "replace", "timeout"])(
  "readiness wait rejects on %s and removes every subscription",
  async (reason) => {
    jest.useFakeTimers();
    try {
      db.get_state = () => "init";
      const controller = new AbortController();
      const actions = mockActions;
      const pending = waitForArtifactSourceReady(actions, {
        signal: controller.signal,
        timeoutMs: 100,
        isCurrent: () => mockActions === actions,
      });
      const rejected = expect(pending).rejects.toThrow();
      if (reason === "abort") controller.abort();
      else if (reason === "replace") {
        mockActions = { ...actions };
        actions.store.emit("change");
      } else if (reason === "timeout") jest.advanceTimersByTime(100);
      else db.emit(reason, Error("load failed"));
      await rejected;
      for (const event of ["ready", "change", "close", "closed", "error"])
        expect(db.listenerCount(event)).toBe(0);
      expect(actions.store.listenerCount("change")).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  },
);

test("unmount cancels a pending source readiness wait", async () => {
  db.get_state = () => "init";
  const mounted = render(view());
  await waitFor(() => expect(db.listenerCount("ready")).toBe(1));
  mounted.unmount();
  expect(db.listenerCount("ready")).toBe(0);
  expect(db.listenerCount("error")).toBe(0);
});

function ContextProbe() {
  const project = useContext(ProjectContext);
  const file = useFileContext();
  return (
    <span>
      {project.project_id}:{file.project_id}:{file.path}
    </span>
  );
}

function view(onSource = (_source: any) => {}) {
  return (
    <ForeignArtifactSource target={target}>
      {(source) => {
        onSource(source);
        return (
          <>
            <ContextProbe />
            <button
              disabled={source.readOnly}
              onClick={() => source.syncdb.set({ input: "edited" })}
            >
              Edit source
            </button>
          </>
        );
      }}
    </ForeignArtifactSource>
  );
}

test.each([undefined, {}, { redux_name: "source-editor" }])(
  "background source runtime renders without a generated Editor component (%j)",
  async (component) => {
    mockComponent = component;
    let source: any;
    const mounted = render(
      view((value) => {
        source = value;
      }),
    );
    await screen.findByRole("button", { name: "Edit source" });
    expect(screen.queryByText("Artifact source unavailable")).toBeNull();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Edit source" }));
    expect(db.set).toHaveBeenCalledWith({ input: "edited" });

    // A missing presentation component is valid, but a replaced registry
    // entry must still immediately remove the editor and reject queued writes.
    const oldHandle = source.syncdb;
    mockActions = { ...mockActions };
    mounted.rerender(view());
    expect(screen.queryByRole("button", { name: "Edit source" })).toBeNull();
    expect(
      screen.getByText("Source conversation closed or reloaded"),
    ).toBeTruthy();
    expect(() => oldHandle.set({ input: "stale" })).toThrow("replaced");
  },
);

test("opens source without navigation and provides source contexts; explicit navigation uses parent event", async () => {
  const event = jest.fn();
  window.addEventListener(FOREIGN_ARTIFACT_CONVERSATION_EVENT, event);
  render(view());
  await screen.findByRole("button", { name: "Edit source" });
  expect(mockOpen).toHaveBeenCalledWith({
    path: "/source.chat",
    embedded: true,
    foreground: false,
    foreground_project: false,
    change_history: false,
    wait_for_ready: true,
  });
  expect(screen.getByText("source:source:/source.chat")).toBeTruthy();
  expect(event).not.toHaveBeenCalled();
  const user = userEvent.setup();
  screen.getByRole("button", { name: "Show in conversation" }).focus();
  await user.keyboard("{Enter}");
  expect(event.mock.calls[0][0].detail).toEqual({
    project_id: "source",
    path: "/source.chat",
    thread_id: "other-thread",
    artifact_id: "same-id",
    agent_id: "source-agent",
    operation_id: "publication",
  });
  await user.click(screen.getByRole("button", { name: "Edit source" }));
  expect(db.set).toHaveBeenCalledWith({ input: "edited" });
  window.removeEventListener(FOREIGN_ARTIFACT_CONVERSATION_EVENT, event);
});

test("source readonly updates disable editing and guard already queued writes", async () => {
  let source: any;
  render(
    view((value) => {
      source = value;
    }),
  );
  await screen.findByRole("button", { name: "Edit source" });
  act(() => {
    mockReadOnly = true;
    mockActions.store.emit("change");
  });
  expect(screen.getByRole("button", { name: "Edit source" })).toBeDisabled();
  expect(() => source.syncdb.set({})).toThrow("no longer writable");
  expect(db.set).not.toHaveBeenCalled();
});

test.each(["closed", "replaced"])(
  "%s runtime cannot retain editable source; retry attaches a fresh runtime",
  async (kind) => {
    let source: any;
    const mounted = render(
      view((value) => {
        source = value;
      }),
    );
    await screen.findByRole("button", { name: "Edit source" });
    const old = source.syncdb;
    if (kind === "closed") {
      act(() => {
        db.get_state = () => "closed";
        db.emit("closed");
      });
    } else {
      mockActions = { ...mockActions };
      mockComponent = { ...mockComponent, runtime_generation: 2 };
      mounted.rerender(view());
    }
    expect(screen.queryByRole("button", { name: "Edit source" })).toBeNull();
    expect(() => old.set({})).toThrow();
    db.get_state = () => "ready";
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: "Edit source" });
    expect(mockOpen).toHaveBeenCalledTimes(2);
  },
);

test("source load error offers keyboard retry without destination fallback", async () => {
  mockOpen.mockRejectedValueOnce(Error("Source denied"));
  render(view());
  await screen.findByText("Source denied", { exact: false });
  expect(screen.queryByRole("button", { name: "Edit source" })).toBeNull();
  screen.getByRole("button", { name: "Retry" }).focus();
  await userEvent.setup().keyboard("{Enter}");
  await screen.findByRole("button", { name: "Edit source" });
});

test("unauthorized source never opens a collaborator runtime", async () => {
  mockAllowed = false;
  render(view());
  await screen.findByText("Source project access is unavailable");
  expect(mockOpen).not.toHaveBeenCalled();
});
