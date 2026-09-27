import { EventEmitter } from "node:events";

const actionsByName = new Map<string, any>();
const storesByName = new Map<string, any>();

const createActionsMock = jest.fn();
const createStoreMock = jest.fn();
const getActionsMock = jest.fn();
const getStoreMock = jest.fn();
const removeStoreMock = jest.fn();
const removeActionsMock = jest.fn();
const getProjectActionsMock = jest.fn();
const projectConatSyncMock = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux_name: (project_id: string, path: string) => `${project_id}:${path}`,
  redux: {
    getActions: (...args) => getActionsMock(...args),
    createActions: (...args) => createActionsMock(...args),
    createStore: (...args) => createStoreMock(...args),
    getStore: (...args) => getStoreMock(...args),
    removeStore: (...args) => removeStoreMock(...args),
    removeActions: (...args) => removeActionsMock(...args),
    getProjectActions: (...args) => getProjectActionsMock(...args),
  },
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      projectConatSync: (...args) => projectConatSyncMock(...args),
    },
  },
}));

jest.mock("./actions", () => ({
  ChatActions: class ChatActions {},
}));

jest.mock("./store", () => ({
  ChatStore: class ChatStore {},
}));

jest.mock("@cocalc/frontend/chat/message-cache", () => ({
  ChatMessageCache: jest.fn().mockImplementation(function ChatMessageCache() {
    this.dispose = jest.fn();
  }),
}));

import { redux } from "@cocalc/frontend/app-framework";
import { getChatActions, initChat, removeWithInstance } from "./register";
import { closeChatSyncdb } from "./close-syncdb";

function makeSyncdb(initialState: string) {
  let state = initialState;
  const events = new EventEmitter();
  const onceHandlers: Record<string, Array<(...args: any[]) => void>> = {};
  const onHandlers: Record<string, Array<(...args: any[]) => void>> = {};
  return {
    opts: { ignoreInitialChanges: true },
    on: jest.fn((event: string, cb: (...args: any[]) => void) => {
      (onHandlers[event] ??= []).push(cb);
      events.on(event, cb);
    }),
    off: jest.fn((event: string, cb: (...args: any[]) => void) => {
      onHandlers[event] = (onHandlers[event] ?? []).filter(
        (handler) => handler !== cb,
      );
      events.off(event, cb);
    }),
    once: jest.fn((event: string, cb: (...args: any[]) => void) => {
      (onceHandlers[event] ??= []).push(cb);
      events.once(event, cb);
    }),
    removeListener: jest.fn((event: string, cb: (...args: any[]) => void) => {
      onHandlers[event] = (onHandlers[event] ?? []).filter(
        (handler) => handler !== cb,
      );
      onceHandlers[event] = (onceHandlers[event] ?? []).filter(
        (handler) => handler !== cb,
      );
      events.removeListener(event, cb);
    }),
    emit: events.emit.bind(events),
    listenerCount: events.listenerCount.bind(events),
    get_state: jest.fn(() => state),
    is_read_only: jest.fn(() => false),
    has_unsaved_changes: jest.fn(() => false),
    save_to_disk: jest.fn(async () => {}),
    project_id: "project-1",
    path: "notes.chat",
    close: jest.fn(() => {
      state = "closed";
      for (const handler of onceHandlers.close ?? []) {
        handler();
      }
    }),
  };
}

function makeChatActions(state: string) {
  const syncdb = makeSyncdb(state);
  return {
    workbenchEnabled: false,
    sendChat: jest.fn(),
    getMessagesInThread: jest.fn(),
    clearAllFilters: jest.fn(),
    setSelectedThread: jest.fn(),
    messageCache: {},
    syncdb,
    dispose: jest.fn(),
    init_from_syncdb: jest.fn(),
    syncdbChange: jest.fn(),
  };
}

describe("chat/register", () => {
  beforeEach(() => {
    actionsByName.clear();
    storesByName.clear();
    jest.clearAllMocks();

    getActionsMock.mockImplementation((name: string) =>
      actionsByName.get(name),
    );
    getStoreMock.mockImplementation((name: string) => storesByName.get(name));
    createActionsMock.mockImplementation((name: string) => {
      const actions = {
        ...makeChatActions("connecting"),
        messageCache: undefined,
        syncdb: undefined,
        setState: jest.fn(),
        set_syncdb: jest.fn(function (syncdb, _store, cache) {
          this.syncdb = syncdb;
          this.messageCache = cache;
        }),
      };
      actionsByName.set(name, actions);
      return actions;
    });
    createStoreMock.mockImplementation((name: string) => {
      if (storesByName.has(name)) throw Error(`store ${name} already exists`);
      const store = {};
      storesByName.set(name, store);
      return store;
    });
    removeStoreMock.mockImplementation((name: string) => {
      storesByName.delete(name);
    });
    removeActionsMock.mockImplementation((name: string) => {
      actionsByName.delete(name);
    });
    getProjectActionsMock.mockReturnValue({
      setNotDeleted: jest.fn(),
      log_opened_time: jest.fn(),
      fs: jest.fn(() => undefined),
    });
  });

  it.each([undefined, false, true])(
    "initializes bootstrap workbench support as %s without mounting an editor",
    (enabled) => {
      projectConatSyncMock.mockReturnValue({
        sync: { immer: () => makeSyncdb("connecting") },
      });
      const actions = initChat("project-1", "agent.chat", {
        instanceKey: "onboarding",
        workbenchEnabled: enabled,
      });
      expect(actions.workbenchEnabled).toBe(enabled === true);
    },
  );

  it("enables an existing prewarmed chat and preserves the flag on ordinary lookup", () => {
    const existing = makeChatActions("ready");
    actionsByName.set("project-1:agent.chat#onboarding", existing);
    const opts = { instanceKey: "onboarding", workbenchEnabled: true };
    expect(initChat("project-1", "agent.chat", opts)).toBe(existing);
    expect(
      initChat("project-1", "agent.chat", { instanceKey: "onboarding" })
        .workbenchEnabled,
    ).toBe(true);
    expect(createActionsMock).not.toHaveBeenCalled();
  });

  it("drops stale closed chat actions from the registry", async () => {
    const name = "project-1:notes.chat";
    const stale = makeChatActions("closed");
    actionsByName.set(name, stale);
    storesByName.set(name, { state: {} });

    expect(getChatActions("project-1", "notes.chat")).toBeUndefined();
    await closeChatSyncdb(stale.syncdb as any);

    expect(stale.dispose).toHaveBeenCalledTimes(1);
    expect(stale.syncdb.close).toHaveBeenCalledTimes(1);
    expect(removeStoreMock).toHaveBeenCalledWith(name);
    expect(removeActionsMock).toHaveBeenCalledWith(name);
  });

  it("recreates stale closed chat actions instead of reusing them", () => {
    const name = "project-1:notes.chat";
    const stale = makeChatActions("closed");
    actionsByName.set(name, stale);
    storesByName.set(name, { state: {} });

    const freshSyncdb = makeSyncdb("connecting");
    projectConatSyncMock.mockReturnValue({
      sync: {
        immer: jest.fn(() => freshSyncdb),
      },
    });

    const actions = initChat("project-1", "notes.chat");

    expect(actions).not.toBe(stale);
    expect(stale.dispose).toHaveBeenCalledTimes(1);
    expect(projectConatSyncMock).toHaveBeenCalledWith({
      project_id: "project-1",
      caller: "chat.syncdb",
      requireRouting: false,
    });
    expect(createActionsMock).toHaveBeenCalledWith(name, expect.any(Function));
    expect(actions.setState).toHaveBeenCalledWith({
      project_id: "project-1",
      path: "notes.chat",
    });
    expect(actions.set_syncdb).toHaveBeenCalledWith(
      freshSyncdb,
      storesByName.get(name),
      expect.any(Object),
    );
  });

  it("keeps reusable chat actions", () => {
    const name = "project-1:notes.chat";
    const live = makeChatActions("connecting");
    actionsByName.set(name, live);

    expect(initChat("project-1", "notes.chat")).toBe(live);
    expect(createActionsMock).not.toHaveBeenCalled();
    expect(removeActionsMock).not.toHaveBeenCalled();
  });

  it("recreates disposed actions whose message cache has been cleared", () => {
    const name = "project-1:notes.chat";
    const stale = { ...makeChatActions("closed"), messageCache: undefined };
    actionsByName.set(name, stale);
    storesByName.set(name, { state: {} });
    projectConatSyncMock.mockReturnValue({
      sync: { immer: () => makeSyncdb("connecting") },
    });

    expect(() => initChat("project-1", "notes.chat")).not.toThrow();
    expect(removeStoreMock).toHaveBeenCalledWith(name);
    expect(removeActionsMock).toHaveBeenCalledWith(name);
  });

  it("can retry initialization after synchronous routing failure", () => {
    projectConatSyncMock.mockImplementationOnce(() => {
      throw Error("routing unavailable");
    });
    expect(() => initChat("project-1", "notes.chat")).toThrow(
      "routing unavailable",
    );
    projectConatSyncMock.mockReturnValue({
      sync: { immer: () => makeSyncdb("connecting") },
    });
    expect(() => initChat("project-1", "notes.chat")).not.toThrow();
  });

  it("closes the syncdb even when dispose clears the reference", async () => {
    const name = "project-1:notes.chat";
    const stale = makeChatActions("closed");
    const syncdb = stale.syncdb;
    stale.dispose.mockImplementation(() => {
      (stale as any).syncdb = undefined;
      (stale as any).messageCache = undefined;
    });
    actionsByName.set(name, stale);
    // Cleanup must remove actions even if the store is already gone.
    expect(getChatActions("project-1", "notes.chat")).toBeUndefined();
    await closeChatSyncdb(syncdb as any);
    expect(syncdb.close).toHaveBeenCalledTimes(1);
    expect(actionsByName.has(name)).toBe(false);
  });

  it("detaches UI immediately, persists before close, and preserves a same-path reopen", async () => {
    const opts = { instanceKey: "collaborators:account:view" };
    const oldDb = makeSyncdb("ready");
    const freshDb = makeSyncdb("ready");
    oldDb.has_unsaved_changes.mockReturnValue(true);
    let finishSave!: () => void;
    oldDb.save_to_disk.mockImplementation(
      () => new Promise<void>((resolve) => (finishSave = resolve)),
    );
    const immer = jest.fn().mockReturnValueOnce(oldDb).mockReturnValue(freshDb);
    projectConatSyncMock.mockReturnValue({ sync: { immer } });
    const old = initChat("project-1", "notes.chat", opts) as any;
    oldDb.emit("ready");
    const cache = old.messageCache;
    old.dispose.mockImplementation(() => {
      old.syncdb = undefined;
      old.messageCache = undefined;
    });
    const name = removeWithInstance("notes.chat", redux, "project-1", opts);
    expect(actionsByName.has(name)).toBe(false);
    expect(storesByName.has(name)).toBe(false);
    expect(cache.dispose).toHaveBeenCalledTimes(1);
    expect(oldDb.listenerCount("change")).toBe(0);
    expect(oldDb.listenerCount("ready")).toBe(0);
    oldDb.emit("change", new Set([{ event: "chat" }]));
    oldDb.emit("ready");
    expect(old.syncdbChange).not.toHaveBeenCalled();
    expect(old.init_from_syncdb).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    expect(oldDb.save_to_disk).toHaveBeenCalledTimes(1);
    expect(oldDb.close).not.toHaveBeenCalled();
    const fresh = initChat("project-1", "notes.chat", opts) as any;
    expect(fresh).not.toBe(old);
    const freshStore = storesByName.get(name);
    oldDb.has_unsaved_changes.mockReturnValue(false);
    finishSave();
    await closeChatSyncdb(oldDb as any);
    expect(oldDb.close).toHaveBeenCalledTimes(1);
    expect(freshDb.close).not.toHaveBeenCalled();
    expect(actionsByName.get(name)).toBe(fresh);
    expect(storesByName.get(name)).toBe(freshStore);
    freshDb.emit("ready");
    freshDb.emit("change", new Set([{ event: "chat" }]));
    expect(fresh.syncdbChange).toHaveBeenCalledTimes(1);
  });
});
