import { boundCollaboratorsApi } from "./workspace-api";

let mockAccount = "alice";
const mockList = jest.fn();
const mockWrite = jest.fn();
const mockProjectList = jest.fn();
const mockRefreshAgents = jest.fn();
const mockRefreshLibrary = jest.fn();
let mockClient = {
  hub: {
    collaborators: {
      listResources: mockList,
      listProjectResources: mockProjectList,
      setPersonalState: mockWrite,
    },
  },
};
jest.mock("@cocalc/frontend/agents/api", () => ({
  refreshNamedAgentsForAccount: (...args) => mockRefreshAgents(...args),
}));
jest.mock("@cocalc/frontend/agents/personal-library", () => ({
  refreshPersonalLibrary: (...args) => mockRefreshLibrary(...args),
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getStore: () => ({ get: () => mockAccount }) },
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    get conat_client() {
      return mockClient;
    },
  },
}));

beforeEach(() => {
  mockAccount = "alice";
  jest.clearAllMocks();
});

test("binds requests to the signed-in account, never a caller-supplied account", async () => {
  mockList.mockResolvedValue({ items: [], coverage: "complete" });
  await boundCollaboratorsApi("alice").listResources({ account_id: "bob" });
  expect(mockList).toHaveBeenCalledWith({ account_id: "alice" });
});

test("owner fallback remains account-bound and rejects a late account-switch response", async () => {
  let resolve!: (value: unknown) => void;
  mockProjectList.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const pending = boundCollaboratorsApi("alice").listProjectResources({
    account_id: "bob",
    project_id: "project",
    kind: "conversation",
    limit: 25,
  });
  expect(mockProjectList).toHaveBeenCalledWith({
    account_id: "alice",
    project_id: "project",
    kind: "conversation",
    limit: 25,
  });
  mockAccount = "bob";
  resolve({
    items: [{ title: "previous private project" }],
    coverage: "partial",
  });
  await expect(pending).rejects.toThrow("session changed");
});

test.each(["account", "server"])(
  "late responses after a %s change are rejected",
  async (kind) => {
    let resolve!: (value: unknown) => void;
    mockList.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = boundCollaboratorsApi("alice").listResources({});
    if (kind === "account") mockAccount = "bob";
    else mockClient = { ...mockClient };
    resolve({
      items: [{ title: "old private metadata" }],
      coverage: "complete",
    });
    await expect(pending).rejects.toThrow("session changed");
  },
);

test.each(["agent", "artifact", "conversation"] as const)(
  "%s alias and collection writes invalidate only the appropriate account cache",
  async (kind) => {
    mockWrite.mockResolvedValue({ alias: "mine", collected: true });
    const api = boundCollaboratorsApi("alice");
    for (const patch of [{ alias: "mine" }, { collected: true }]) {
      await api.setPersonalState({
        project_id: "project",
        resource_id: "resource",
        kind,
        patch,
      });
    }
    expect(mockRefreshAgents.mock.calls).toEqual(
      kind === "agent" ? [["alice"], ["alice"]] : [],
    );
    expect(mockRefreshLibrary.mock.calls).toEqual(
      kind === "artifact" ? [["alice"], ["alice"]] : [],
    );
    jest.clearAllMocks();
    await api.setPersonalState({
      project_id: "project",
      resource_id: "resource",
      kind,
      patch: { following: true, muted: true, read_through: 4 },
    });
    expect(mockRefreshAgents).not.toHaveBeenCalled();
    expect(mockRefreshLibrary).not.toHaveBeenCalled();
  },
);

test("failed or previous-account writes cannot publish a cache refresh", async () => {
  const api = boundCollaboratorsApi("alice");
  const opts = {
    project_id: "project",
    resource_id: "resource",
    kind: "artifact" as const,
    patch: { collected: true },
  };
  mockWrite.mockRejectedValueOnce(Error("Access removed"));
  await expect(api.setPersonalState(opts)).rejects.toThrow("Access removed");
  let resolve!: (value: unknown) => void;
  mockWrite.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const pending = api.setPersonalState(opts);
  mockAccount = "bob";
  resolve({ collected: true });
  await expect(pending).rejects.toThrow("session changed");
  expect(mockRefreshAgents).not.toHaveBeenCalled();
  expect(mockRefreshLibrary).not.toHaveBeenCalled();
});
