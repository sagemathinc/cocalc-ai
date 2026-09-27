/** @jest-environment jsdom */
import { StrictMode } from "react";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import {
  useChatComposerDraft,
  writeChatComposerDraft,
} from "../use-chat-composer-draft";

const local = new Map<string, any>();
const remote = new Map<string, any>();
const save = jest.fn(async (account, key, value) => {
  remote.set(`${account}:${key}`, value);
});
let load: (account: string, key: string) => Promise<any> = async (
  account,
  key,
) => remote.get(`${account}:${key}`);
jest.mock("@cocalc/frontend/misc", () => ({
  get_local_storage: (key) => local.get(key),
  set_local_storage: (key, value) => local.set(key, value),
  delete_local_storage: (key) => local.delete(key),
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      conat: () => ({
        sync: {
          akv: ({ account_id }) => ({
            get: (key) => load(account_id, key),
            set: (key, value) => save(account_id, key, value),
            delete: (key) => remote.delete(`${account_id}:${key}`),
            close: jest.fn(),
          }),
        },
      }),
    },
  },
}));
let sequence = 0;
const options = () => ({
  account_id: "account",
  project_id: "project",
  path: `test-${sequence++}.chat`,
  composerDraftKey: 1,
});
const settle = () =>
  act(async () => {
    await Promise.resolve();
  });

function localKey(opts: ReturnType<typeof options>) {
  return `chat-composer-draft:${JSON.stringify([
    opts.account_id,
    `${opts.project_id}:${opts.path}:${opts.composerDraftKey}`,
  ])}`;
}

// A browser reload loses module-local sessions and shadows, not localStorage.
// Keep the renderer's React instance while loading a fresh draft module.
function reloadedDraftHook(): typeof useChatComposerDraft {
  const react = jest.requireActual("react");
  let hook!: typeof useChatComposerDraft;
  try {
    jest.isolateModules(() => {
      jest.doMock("react", () => react);
      hook = require("../use-chat-composer-draft").useChatComposerDraft;
    });
  } finally {
    jest.dontMock("react");
  }
  return hook;
}
beforeEach(() => {
  load = async (account, key) => remote.get(`${account}:${key}`);
  save.mockClear();
  save.mockImplementation(async (account, key, value) => {
    remote.set(`${account}:${key}`, value);
  });
});

test("migrates an existing browser draft once without changing its remote key", async () => {
  const opts = options();
  const legacy = `chat-composer-draft:${opts.project_id}:${opts.path}:1`;
  local.set(legacy, "unsaved legacy draft");
  const hook = renderHook(() => useChatComposerDraft(opts));
  await settle();
  expect(hook.result.current.input).toBe("unsaved legacy draft");
  expect(local.has(legacy)).toBe(false);
  hook.unmount();
  await settle();
  expect(save.mock.calls.at(-1)?.[1]).toBe(`${opts.project_id}:${opts.path}:1`);
  const other = renderHook(() =>
    useChatComposerDraft({ ...opts, account_id: "other" }),
  );
  await settle();
  expect(other.result.current.input).toBe("");
  other.unmount();
  await settle();
});

test("an outstanding save cannot finish after and overwrite a remounted editor's new draft", async () => {
  const opts = options();
  let finish!: () => void;
  save.mockImplementationOnce(async (account, key, value) => {
    await new Promise<void>((r) => {
      finish = r;
    });
    remote.set(`${account}:${key}`, value);
  });
  const first = renderHook(() => useChatComposerDraft(opts));
  await settle();
  act(() => first.result.current.setInput("old pending save"));
  first.unmount();
  await settle();
  const second = renderHook(() => useChatComposerDraft(opts));
  act(() => second.result.current.setInput("newest"));
  second.unmount();
  await act(async () => {
    finish();
  });
  await settle();
  const third = renderHook(() => useChatComposerDraft(opts));
  await settle();
  expect(third.result.current.input).toBe("newest");
  third.unmount();
  await settle();
  expect(save.mock.calls.at(-1)?.[2].text).toBe("newest");
});

test("two mounted views share edits; stale unmount cannot restore an older draft", async () => {
  const opts = options();
  const project = renderHook(() => useChatComposerDraft(opts));
  await settle();
  act(() => project.result.current.setInput("project draft"));
  const agent = renderHook(() => useChatComposerDraft(opts));
  await settle();
  expect(agent.result.current.input).toBe("project draft");
  act(() => agent.result.current.setInput("new agent draft"));
  expect(project.result.current.input).toBe("new agent draft");
  project.unmount();
  agent.unmount();
  await settle();
  const reopened = renderHook(() => useChatComposerDraft(opts));
  await settle();
  expect(reopened.result.current.input).toBe("new agent draft");
  reopened.unmount();
  await settle();
  expect([...local.values()]).not.toContain("project draft");
});

test("switching the active composer preserves its draft and sends once", async () => {
  const opts = options();
  const sent: string[] = [];

  function View({ label, visible }: { label: string; visible: boolean }) {
    const { input, setInput, clearInput } = useChatComposerDraft(opts);
    return visible ? (
      <>
        <label>
          {label} composer
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
        </label>
        <button
          type="button"
          onClick={() => {
            sent.push(input);
            void clearInput();
          }}
        >
          Send {label}
        </button>
      </>
    ) : null;
  }

  function Views({ active }: { active: "project" | "agent" }) {
    return (
      <>
        <View label="Project" visible={active === "project"} />
        <View label="Agent" visible={active === "agent"} />
      </>
    );
  }

  const views = render(<Views active="project" />);
  await settle();
  fireEvent.change(screen.getByRole("textbox", { name: "Project composer" }), {
    target: { value: "one draft" },
  });
  views.rerender(<Views active="agent" />);
  await settle();
  expect(
    screen.queryByRole("textbox", { name: "Project composer" }),
  ).toBeNull();
  expect(
    (
      screen.getByRole("textbox", {
        name: "Agent composer",
      }) as HTMLInputElement
    ).value,
  ).toBe("one draft");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send Agent" }));
  });
  expect(sent).toEqual(["one draft"]);
  views.rerender(<Views active="project" />);
  await settle();
  expect(
    (
      screen.getByRole("textbox", {
        name: "Project composer",
      }) as HTMLInputElement
    ).value,
  ).toBe("");
  views.unmount();
  await settle();
});

test("send clears every mounted view and persists an empty snapshot", async () => {
  const opts = options();
  const first = renderHook(() => useChatComposerDraft(opts));
  const second = renderHook(() => useChatComposerDraft(opts));
  await settle();
  act(() => first.result.current.setInput("to send"));
  await act(() => second.result.current.clearInput());
  expect(first.result.current.input).toBe("");
  first.unmount();
  second.unmount();
  await settle();
  expect(save.mock.calls.at(-1)?.[2].text).toBe("");
});

test("programmatic writes and clearing another draft key update mounted views", async () => {
  const opts = options();
  const first = renderHook(() => useChatComposerDraft(opts));
  const second = renderHook(() =>
    useChatComposerDraft({ ...opts, composerDraftKey: 2 }),
  );
  await settle();
  act(() => first.result.current.setInput("first"));
  await act(async () => {
    await writeChatComposerDraft({ ...opts, text: "appended", append: true });
  });
  expect(first.result.current.input).toBe("first\n\nappended");
  await act(() => second.result.current.clearComposerDraft(1));
  expect(first.result.current.input).toBe("");
  first.unmount();
  second.unmount();
  await settle();
});

test("guarded append hydrates and preserves remote text including authored whitespace", async () => {
  const opts = options();
  const key = `${opts.account_id}:${opts.project_id}:${opts.path}:1`;
  remote.set(key, {
    version: 1,
    text: "unfinished  \n",
    updatedAt: Date.now(),
  });
  await expect(
    writeChatComposerDraft({
      ...opts,
      text: "reference",
      append: true,
      isCurrent: () => true,
    }),
  ).resolves.toBe("unfinished  \n\n\nreference");
  const hook = renderHook(() => useChatComposerDraft(opts));
  await settle();
  expect(hook.result.current.input).toBe("unfinished  \n\n\nreference");
  hook.unmount();
  await settle();
});

test("a canceled share waiting for hydration cannot append to the destination", async () => {
  const opts = options();
  let current = true;
  let finish!: (value: any) => void;
  load = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = writeChatComposerDraft({
    ...opts,
    text: "never insert",
    append: true,
    isCurrent: () => current,
  });
  current = false;
  finish({ version: 1, text: "existing draft", updatedAt: Date.now() });
  await expect(pending).rejects.toThrow("changed");
  await settle();
  expect(
    save.mock.calls.every((call) => !call[2].text.includes("never insert")),
  ).toBe(true);
});

test("a shared reference appends to newer edits in an already mounted destination", async () => {
  const opts = options();
  let finish!: (value: any) => void;
  load = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const hook = renderHook(() => useChatComposerDraft(opts));
  const pending = writeChatComposerDraft({
    ...opts,
    text: "reference",
    append: true,
    isCurrent: () => true,
  });
  act(() => hook.result.current.setInput("new live edit"));
  await act(async () => {
    finish({ version: 1, text: "stale remote draft", updatedAt: Date.now() });
    await pending;
  });
  expect(hook.result.current.input).toBe("new live edit\n\nreference");
  hook.unmount();
  await settle();
});

test("failed share hydration neither appends nor overwrites an unread draft on cleanup", async () => {
  const opts = options();
  load = async () => {
    throw Error("disconnected");
  };
  await expect(
    writeChatComposerDraft({
      ...opts,
      text: "never insert",
      append: true,
      isCurrent: () => true,
    }),
  ).rejects.toThrow("could not be loaded");
  await settle();
  expect(save).not.toHaveBeenCalled();
});

test("accounts, threads, and prompt suffixes are isolated", async () => {
  const opts = options();
  const first = renderHook(() => useChatComposerDraft(opts));
  const others = [
    { ...opts, account_id: "other" },
    { ...opts, composerDraftKey: 2 },
    { ...opts, suffix: "acp-prompt" },
  ].map((o) => renderHook(() => useChatComposerDraft(o)));
  await settle();
  act(() => first.result.current.setInput("private"));
  for (const other of others) expect(other.result.current.input).toBe("");
  first.unmount();
  others.forEach((o) => o.unmount());
  await settle();
});

test.each(["edit", "clear"])(
  "late remote initialization cannot undo a local %s",
  async (action) => {
    const opts = options();
    let resolve!: (value: any) => void;
    load = () =>
      new Promise((r) => {
        resolve = r;
      });
    const hook = renderHook(() => useChatComposerDraft(opts));
    if (action === "edit") act(() => hook.result.current.setInput("new"));
    else await act(() => hook.result.current.clearInput());
    await act(async () => {
      resolve({ version: 1, text: "old", updatedAt: Date.now() + 1000 });
    });
    expect(hook.result.current.input).toBe(action === "edit" ? "new" : "");
    hook.unmount();
    await settle();
  },
);

test("StrictMode and rapid remount reuse the live controller during cleanup", async () => {
  const opts = options();
  const first = renderHook(() => useChatComposerDraft(opts), {
    wrapper: StrictMode,
  });
  await settle();
  act(() => first.result.current.setInput("before"));
  first.unmount();
  const second = renderHook(() => useChatComposerDraft(opts));
  act(() => second.result.current.setInput("after"));
  await settle();
  expect(second.result.current.input).toBe("after");
  second.unmount();
  await settle();
  expect(save.mock.calls.at(-1)?.[2].text).toBe("after");
});

describe("browser lifecycle recovery", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_790_524_324_045);
    // The old page can disappear with remote writes still unacknowledged.
    save.mockImplementation(async () => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test.each(["pagehide", "hidden"])(
    "%s synchronously saves the last keystroke before debounce, and a cold reload rejects older remote text",
    async (event) => {
      const opts = options();
      const timestamp = Date.now();
      remote.set(`${opts.account_id}:${opts.project_id}:${opts.path}:1`, {
        version: 1,
        text: "old remote",
        updatedAt: timestamp - 1000,
      });
      const first = renderHook(() => useChatComposerDraft(opts));
      await settle();
      act(() => first.result.current.setInput("private last keystroke  \n"));
      act(() => {
        if (event === "pagehide") window.dispatchEvent(new Event("pagehide"));
        else {
          jest
            .spyOn(document, "visibilityState", "get")
            .mockReturnValue("hidden");
          document.dispatchEvent(new Event("visibilitychange"));
        }
      });
      // No timers or React unmount have run: navigation must be safe right now.
      expect(local.get(localKey(opts))).toMatchObject({
        version: 1,
        text: "private last keystroke  \n",
      });
      expect(local.get(localKey(opts)).updatedAt).toBeGreaterThanOrEqual(
        timestamp,
      );
      expect(save).not.toHaveBeenCalled();
      first.unmount();
      await settle();
      const useReloaded = reloadedDraftHook();
      const second = renderHook(() => useReloaded(opts));
      await settle();
      expect(second.result.current.input).toBe("private last keystroke  \n");
      second.unmount();
      await settle();
    },
  );

  test("a cold reload preserves a synchronous clear tombstone even if the old remote save has the same clock millisecond", async () => {
    const opts = options();
    remote.set(`${opts.account_id}:${opts.project_id}:${opts.path}:1`, {
      version: 1,
      text: "already sent",
      updatedAt: Date.now(),
    });
    const first = renderHook(() => useChatComposerDraft(opts));
    await settle();
    let cleared!: Promise<void>;
    act(() => {
      cleared = first.result.current.clearInput();
    });
    expect(local.get(localKey(opts))).toMatchObject({ version: 1, text: "" });
    expect(local.get(localKey(opts)).updatedAt).toBeGreaterThan(Date.now());
    await act(() => cleared);
    first.unmount();
    await settle();
    const useReloaded = reloadedDraftHook();
    const second = renderHook(() => useReloaded(opts));
    await settle();
    expect(second.result.current.input).toBe("");
    second.unmount();
    await settle();
  });

  test("listeners are shared by mounted views and removed on the last release, including account changes", async () => {
    const add = jest.spyOn(window, "addEventListener");
    const remove = jest.spyOn(window, "removeEventListener");
    const addDocument = jest.spyOn(document, "addEventListener");
    const removeDocument = jest.spyOn(document, "removeEventListener");
    const opts = options();
    const first = renderHook((o) => useChatComposerDraft(o), {
      initialProps: opts,
    });
    const second = renderHook(() => useChatComposerDraft(opts));
    await settle();
    act(() => first.result.current.setInput("account A only"));
    const handlers = add.mock.calls.filter(([event]) => event === "pagehide");
    expect(handlers).toHaveLength(1);
    expect(
      addDocument.mock.calls.filter(([event]) => event === "visibilitychange"),
    ).toHaveLength(1);
    first.rerender({ ...opts, account_id: "other-account" });
    await settle();
    expect(first.result.current.input).toBe("");
    act(() => first.result.current.setInput("account B only"));
    second.unmount();
    await settle();
    expect(
      remove.mock.calls.some(
        ([event, fn]) => event === "pagehide" && fn === handlers[0][1],
      ),
    ).toBe(true);
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(local.get(localKey(opts)).text).toBe("account A only");
    expect(
      local.get(localKey({ ...opts, account_id: "other-account" })).text,
    ).toBe("account B only");
    first.unmount();
    await settle();
    expect(
      remove.mock.calls.filter(([event]) => event === "pagehide"),
    ).toHaveLength(2);
    expect(
      removeDocument.mock.calls.filter(
        ([event]) => event === "visibilitychange",
      ),
    ).toHaveLength(2);
  });

  test("a newer remote edit still wins over a valid older local snapshot", async () => {
    const opts = options();
    local.set(localKey(opts), {
      version: 1,
      text: "older local",
      updatedAt: Date.now() - 1000,
    });
    remote.set(`${opts.account_id}:${opts.project_id}:${opts.path}:1`, {
      version: 1,
      text: "newer remote",
      updatedAt: Date.now(),
    });
    const hook = renderHook(() => useChatComposerDraft(opts));
    await settle();
    expect(hook.result.current.input).toBe("newer remote");
    hook.unmount();
    await settle();
  });

  test.each([
    { version: 2, text: "unsupported", updatedAt: 1 },
    { version: 1, text: "invalid", updatedAt: "1" },
    { version: 1, text: "invalid", updatedAt: NaN },
    { version: 1, text: "invalid", updatedAt: Infinity },
    { version: 1, text: "invalid", updatedAt: -1 },
    { version: 1, text: {}, updatedAt: 1 },
  ])("ignores malformed local snapshot %#", async (snapshot) => {
    const opts = options();
    local.set(localKey(opts), snapshot);
    const hook = renderHook(() => useChatComposerDraft(opts));
    await settle();
    expect(hook.result.current.input).toBe("");
    expect(local.has(localKey(opts))).toBe(false);
    hook.unmount();
    await settle();
  });

  test("local snapshots retain the 200000-character bound on writes and cold reads", async () => {
    const opts = options();
    const first = renderHook(() => useChatComposerDraft(opts));
    await settle();
    const limit = "x".repeat(200_000);
    act(() => {
      first.result.current.setInput(limit);
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(local.get(localKey(opts)).text.length).toBe(200_000);
    act(() => {
      first.result.current.setInput(limit + "x");
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(local.has(localKey(opts))).toBe(false);
    expect(first.result.current.input).toBe(limit + "x");
    first.unmount();
    await settle();
    local.set(localKey(opts), {
      version: 1,
      text: limit + "x",
      updatedAt: Date.now(),
    });
    const useReloaded = reloadedDraftHook();
    const second = renderHook(() => useReloaded(opts));
    await settle();
    expect(second.result.current.input).toBe("");
    second.unmount();
    await settle();
  });

  test("unmount removes lifecycle listeners before pending remote hydration settles", async () => {
    const add = jest.spyOn(window, "addEventListener");
    const remove = jest.spyOn(window, "removeEventListener");
    let finish!: (value: any) => void;
    load = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const opts = options();
    const hook = renderHook(() => useChatComposerDraft(opts));
    const handler = add.mock.calls.find(([event]) => event === "pagehide")![1];
    hook.unmount();
    expect(
      remove.mock.calls.some(
        ([event, fn]) => event === "pagehide" && fn === handler,
      ),
    ).toBe(true);
    await act(async () => finish(undefined));
    await settle();
  });
});
