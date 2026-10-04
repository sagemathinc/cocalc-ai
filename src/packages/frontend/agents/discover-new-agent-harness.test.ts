import { EventEmitter } from "events";
import { redux } from "@cocalc/frontend/app-framework";
import { initChat, removeWithInstance } from "@cocalc/frontend/chat/register";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { discoverNewAgentHarness } from "./discover-new-agent-harness";

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getProjectActions: jest.fn() },
}));
jest.mock("@cocalc/frontend/app-framework/project-runtime", () => ({
  ensureProjectReduxRuntime: jest.fn(),
}));
jest.mock("@cocalc/frontend/chat/register", () => ({
  initChat: jest.fn(),
  removeWithInstance: jest.fn(),
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: { conat_client: { controlAcp: jest.fn() } },
}));

const runtime = {
  version: 1,
  kind: "acp",
  profile: {
    version: 2,
    kind: "acp",
    id: "claude-code",
    revision: "0.85.1",
    cwd: "/home/user",
    executionPolicy: "full-access",
    credentialMode: "project-managed",
  },
} as const;
const credential = {
  version: 1,
  provider: "anthropic",
  mode: "account-api-key",
  credentialId: "private-selection",
} as const;
const request = {
  projectId: "project-a",
  projectHome: "/home/user",
  runtime,
  credential,
  assertCurrent: jest.fn(),
};
const rm = jest.fn();
const actions = {
  syncdb: Object.assign(new EventEmitter(), {
    get_state: () => "ready",
    save: jest.fn(),
    close: jest.fn(),
  }),
  createEmptyThread: jest.fn(),
  save_to_disk: jest.fn(),
  sendChat: jest.fn(),
};
const result = {
  profile: runtime.profile,
  controls: { version: 1, configOptions: [] },
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(redux.getProjectActions).mockReturnValue({
    fs: () => ({ rm }),
    ensureContainingDirectoryExists: jest.fn(),
  } as any);
  jest.mocked(initChat).mockReturnValue(actions as any);
  actions.createEmptyThread.mockReturnValue("thread-a");
  jest
    .mocked(webapp_client.conat_client.controlAcp)
    .mockResolvedValue({ ok: true, harness: result } as any);
});

test("discovers in a disposable saved draft without a prompt or shared credential metadata", async () => {
  await expect(discoverNewAgentHarness(request)).resolves.toEqual(result);
  expect(actions.createEmptyThread).toHaveBeenCalledWith({
    name: "Harness option discovery",
    threadAgent: { mode: "acp", runtime },
  });
  expect(actions.syncdb.save).toHaveBeenCalledTimes(1);
  expect(actions.save_to_disk).toHaveBeenCalledTimes(1);
  expect(actions.sendChat).not.toHaveBeenCalled();
  expect(webapp_client.conat_client.controlAcp).toHaveBeenCalledWith(
    expect.objectContaining({
      project_id: "project-a",
      action: "discover_harness_v1",
      harness_credential: credential,
    }),
  );
  const path = jest.mocked(initChat).mock.calls[0][1];
  expect(path).toMatch(/\/discovery-.*\.chat$/);
  expect(removeWithInstance).toHaveBeenCalledWith(path, redux, "project-a", {
    instanceKey: "new-agent-harness-discovery",
  });
  expect(rm).toHaveBeenCalledWith(path, { force: true });
  expect(actions.syncdb.close).toHaveBeenCalledTimes(1);
});

test("discovery failure still closes and removes the temporary context", async () => {
  jest
    .mocked(webapp_client.conat_client.controlAcp)
    .mockRejectedValueOnce(Error("unavailable"));
  await expect(discoverNewAgentHarness(request)).rejects.toThrow("unavailable");
  expect(removeWithInstance).toHaveBeenCalledTimes(1);
  expect(rm).toHaveBeenCalledTimes(1);
});

test("waits for the sync session to close before deleting the discovery file", async () => {
  let finishClose!: () => void;
  const closed = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
  let beganClose!: () => void;
  const closing = new Promise<void>((resolve) => {
    beganClose = resolve;
  });
  actions.syncdb.close.mockImplementationOnce(() => {
    beganClose();
    return closed;
  });
  const discovery = discoverNewAgentHarness(request);
  await closing;
  expect(rm).not.toHaveBeenCalled();
  finishClose();
  await expect(discovery).resolves.toEqual(result);
  expect(rm).toHaveBeenCalledTimes(1);
});

test("changing accounts during discovery cannot publish its result", async () => {
  let changed = false;
  jest
    .mocked(webapp_client.conat_client.controlAcp)
    .mockImplementationOnce(async () => {
      changed = true;
      return { ok: true, harness: result } as any;
    });
  await expect(
    discoverNewAgentHarness({
      ...request,
      assertCurrent: () => {
        if (changed) throw Error("Account changed");
      },
    }),
  ).rejects.toThrow("Account changed");
  expect(rm).toHaveBeenCalledTimes(1);
});
