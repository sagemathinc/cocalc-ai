import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Map } from "immutable";
import {
  refreshPersonalLibrary,
  usePersonalLibrary,
} from "@cocalc/frontend/agents/personal-library";
import {
  refreshNamedAgents,
  refreshNamedAgentsForAccount,
  useNamedAgents,
} from "@cocalc/frontend/agents/api";
import { AvailableConversation } from "@cocalc/frontend/agents/available-conversation";

let mockAccount = "";
const mockLibrary = jest.fn();
const mockNames = jest.fn();
const mockNameWrite = jest.fn();
const mockProjects = Map();
const mockClient = {
  hub: {
    personalLibrary: { list: mockLibrary, name: mockNameWrite },
    agent: { listNamedAgents: mockNames },
  },
};
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (store: string) =>
    store === "account" ? mockAccount : mockProjects,
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    get account_id() {
      return mockAccount;
    },
    get conat_client() {
      return mockClient;
    },
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const snapshot = (pin: string) => ({ aliases: [], pins: [pin] });
let sequence = 0;
beforeEach(() => {
  jest.clearAllMocks();
  mockAccount = `account-${sequence++}`;
});

test("Library invalidation refreshes retained views and prevents a pre-write load from restoring stale aliases", async () => {
  const stale = deferred<ReturnType<typeof snapshot>>();
  mockLibrary
    .mockReturnValueOnce(stale.promise)
    .mockResolvedValueOnce(snapshot("new"));
  const view = renderHook(() => usePersonalLibrary());
  act(() => refreshPersonalLibrary(mockAccount));
  await waitFor(() => expect(view.result.current.pins).toEqual(["new"]));
  await act(async () => stale.resolve(snapshot("old")));
  expect(view.result.current.pins).toEqual(["new"]);
  view.unmount();
  const reopened = renderHook(() => usePersonalLibrary());
  expect(reopened.result.current.pins).toEqual(["new"]);
  expect(mockLibrary).toHaveBeenCalledTimes(2);
});

test("Library invalidation is account-scoped and also affects the next mount", async () => {
  mockLibrary
    .mockResolvedValueOnce(snapshot("first"))
    .mockResolvedValueOnce(snapshot("fresh"));
  const account = mockAccount;
  const view = renderHook(() => usePersonalLibrary());
  await waitFor(() => expect(view.result.current.pins).toEqual(["first"]));
  act(() => refreshPersonalLibrary("other-account"));
  expect(mockLibrary).toHaveBeenCalledTimes(1);
  view.unmount();
  act(() => refreshPersonalLibrary(account));
  const reopened = renderHook(() => usePersonalLibrary());
  await waitFor(() => expect(reopened.result.current.pins).toEqual(["fresh"]));
  expect(mockLibrary).toHaveBeenCalledTimes(2);
});

test("a Library write overlapping external invalidation rechecks rather than publishing an older snapshot", async () => {
  const pending = deferred<ReturnType<typeof snapshot>>();
  mockLibrary
    .mockResolvedValueOnce(snapshot("initial"))
    .mockResolvedValueOnce(snapshot("external"))
    .mockResolvedValueOnce(snapshot("both-writes"));
  mockNameWrite.mockReturnValueOnce(pending.promise);
  const view = renderHook(() => usePersonalLibrary());
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  let writing!: Promise<unknown>;
  act(() => {
    writing = view.result.current.setName("project", "entry", "mine");
  });
  act(() => refreshPersonalLibrary(mockAccount));
  await waitFor(() => expect(view.result.current.pins).toEqual(["external"]));
  await act(async () => {
    pending.resolve(snapshot("old-write"));
    await writing;
  });
  await waitFor(() =>
    expect(view.result.current.pins).toEqual(["both-writes"]),
  );
});

test("named-agent invalidation refreshes only the matching account and rejects stale in-flight results", async () => {
  const stale = deferred<{ enabled: boolean; agents: never[] }>();
  mockNames
    .mockReturnValueOnce(stale.promise)
    .mockResolvedValueOnce({ enabled: true, agents: [] });
  const view = renderHook(() => useNamedAgents());
  act(() => refreshNamedAgentsForAccount("other-account"));
  expect(mockNames).toHaveBeenCalledTimes(1);
  act(() => refreshNamedAgentsForAccount(mockAccount));
  await waitFor(() =>
    expect(view.result.current.directory?.enabled).toBe(true),
  );
  await act(async () => stale.resolve({ enabled: false, agents: [] }));
  expect(view.result.current.directory?.enabled).toBe(true);
  expect(mockNames).toHaveBeenCalledTimes(2);
});

test("late Library reads and queued writes cannot cross an account switch", async () => {
  const pending = deferred<ReturnType<typeof snapshot>>();
  mockLibrary
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(snapshot("other-account"));
  const view = renderHook(() => usePersonalLibrary());
  let writing!: Promise<unknown>;
  act(() => {
    writing = view.result.current.setName("project", "entry", "private-alias");
  });
  const rejected = expect(writing).rejects.toThrow("Account changed");
  mockAccount = `other-${mockAccount}`;
  view.rerender();
  await waitFor(() =>
    expect(view.result.current.pins).toEqual(["other-account"]),
  );
  await act(async () => {
    pending.resolve(snapshot("previous-account"));
    await rejected;
  });
  expect(view.result.current.pins).toEqual(["other-account"]);
  expect(mockNameWrite).not.toHaveBeenCalled();
});

test("legacy zero-argument retry adapters still refresh when the button forwards its click event", async () => {
  const user = userEvent.setup();
  mockNames.mockResolvedValue({ enabled: true, agents: [] });
  function View() {
    useNamedAgents();
    return (
      <AvailableConversation available={false} retry={refreshNamedAgents}>
        {null}
      </AvailableConversation>
    );
  }
  render(<View />);
  await waitFor(() => expect(mockNames).toHaveBeenCalledTimes(1));
  screen.getByRole("button", { name: "Retry connection" }).focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(mockNames).toHaveBeenCalledTimes(2));
});
