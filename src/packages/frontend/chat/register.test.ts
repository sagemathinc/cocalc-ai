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

import { getChatActions, initChat } from "./register";

function makeSyncdb(initialState: string) {
  let state = initialState;
  const onceHandlers: Record<string, Array<(...args: any[]) => void>> = {};
  const onHandlers: Record<string, Array<(...args: any[]) => void>> = {};
  return {
    opts: { ignoreInitialChanges: true },
    on: jest.fn((event: string, cb: (...args: any[]) => void) => {
      (onHandlers[event] ??= []).push(cb);
    }),
    off: jest.fn((event: string, cb: (...args: any[]) => void) => {
      onHandlers[event] = (onHandlers[event] ?? []).filter(
        (handler) => handler !== cb,
      );
    }),
    once: jest.fn((event: string, cb: (...args: any[]) => void) => {
      (onceHandlers[event] ??= []).push(cb);
    }),
    removeListener: jest.fn((event: string, cb: (...args: any[]) => void) => {
      onHandlers[event] = (onHandlers[event] ?? []).filter(
        (handler) => handler !== cb,
      );
      onceHandlers[event] = (onceHandlers[event] ?? []).filter(
        (handler) => handler !== cb,
      );
    }),
    get_state: jest.fn(() => state),
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
    sendChat: jest.fn(),
    getMessagesInThread: jest.fn(),
    clearAllFilters: jest.fn(),
    setSelectedThread: jest.fn(),
    messageCache: {},
    syncdb,
    dispose: jest.fn(),
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
        setState: jest.fn(),
        set_syncdb: jest.fn(),
      };
      actionsByName.set(name, actions);
      return actions;
    });
    createStoreMock.mockImplementation((name: string) => {
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

  it("drops stale closed chat actions from the registry", () => {
    const name = "project-1:notes.chat";
    const stale = makeChatActions("closed");
    actionsByName.set(name, stale);
    storesByName.set(name, { state: {} });

    expect(getChatActions("project-1", "notes.chat")).toBeUndefined();

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
});
