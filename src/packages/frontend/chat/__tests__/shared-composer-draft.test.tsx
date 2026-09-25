/** @jest-environment jsdom */
import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import {
  useChatComposerDraft,
  writeChatComposerDraft,
} from "../use-chat-composer-draft";

const local = new Map<string, string>();
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
