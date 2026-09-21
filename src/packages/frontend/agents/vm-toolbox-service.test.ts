import { fromJS } from "immutable";
import {
  contextForVmToolbox,
  prepareVmSsh,
  saveVmToolbox,
} from "./vm-toolbox-service";
import { VM_TOOLBOX_SETTING } from "./vm-toolbox-model";

const id = "062225f1-1cc6-4241-976d-64e5dd0c9cf6";
const other = "162225f1-1cc6-4241-976d-64e5dd0c9cf6";
let mockAccount = "alice";
let mockBindings: any[] = [];
const mockResolve = jest.fn();
const mockList = jest.fn();
const mockExec = jest.fn();
const mockSave = jest.fn();
const mockGetVm = jest.fn();
const mockWrite = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: () => ({
      get: (key) =>
        key === "account_id"
          ? mockAccount
          : fromJS({ [VM_TOOLBOX_SETTING]: JSON.stringify(mockBindings) }),
    }),
    getActions: () => ({
      set_other_settings_and_wait: (...args) => mockSave(...args),
    }),
  },
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        agent: { resolveIdentity: (...args) => mockResolve(...args) },
        compute: {
          listProjectVms: (...args) => mockList(...args),
          getProjectVm: (...args) => mockGetVm(...args),
        },
      },
    },
    project_client: {
      exec: (...args) => mockExec(...args),
      read_text_file: async () => "Host existing\n  HostName example.com\n",
      write_text_file: (...args) => mockWrite(...args),
    },
  },
}));

const binding = {
  agentId: id,
  projectId: id,
  path: "agent.chat",
  threadId: "thread",
  vms: [{ vmId: id, notes: "hello" }],
};
const request = {
  accountId: "alice",
  projectId: id,
  path: "agent.chat",
  threadId: "thread",
};
beforeEach(() => {
  jest.clearAllMocks();
  mockAccount = "alice";
  mockBindings = [binding];
  mockResolve.mockResolvedValue({ agent_id: id });
  mockList.mockResolvedValue([{ id, name: "connector", state: "ready" }]);
  mockExec.mockResolvedValue({ stdout: "", stderr: "", exit_code: 0 });
  mockGetVm.mockResolvedValue({
    id,
    state: "ready",
    public_hostname: "vm.example.com",
    ssh_user: "user",
  });
});

test("resolves current identity and current project VM access before supplying context", async () => {
  expect(await contextForVmToolbox(request)).toContain("connector");
  expect(mockList).toHaveBeenCalledWith({ project_id: id });
});
test("a replaced identity or different thread does not inherit bindings", async () => {
  mockResolve.mockResolvedValue({ agent_id: other });
  expect(await contextForVmToolbox(request)).toBe("");
  expect(await contextForVmToolbox({ ...request, threadId: "another" })).toBe(
    "",
  );
  expect(mockList).not.toHaveBeenCalled();
});
test("account switches across asynchronous resolution abort context delivery", async () => {
  mockResolve.mockImplementationOnce(async () => {
    mockAccount = "bob";
    return { agent_id: id };
  });
  await expect(contextForVmToolbox(request)).rejects.toThrow("Account changed");
  expect(mockList).not.toHaveBeenCalled();
});
test("detach during VM lookup removes the context", async () => {
  mockList.mockImplementationOnce(async () => {
    mockBindings = [];
    return [];
  });
  expect(await contextForVmToolbox(request)).toBe("");
});
test("does not silently fall back to owned VMs or old cached state after loss of project access", async () => {
  mockList.mockResolvedValue([]);
  expect(await contextForVmToolbox(request)).toContain(
    '"status": "unavailable"',
  );
});
test("save preserves other agents and refuses a different human", async () => {
  mockBindings = [binding, { ...binding, agentId: other }];
  await saveVmToolbox("alice", { ...binding, vms: [] });
  expect(JSON.parse(mockSave.mock.calls[0][1])).toEqual([
    { ...binding, agentId: other },
  ]);
  await expect(saveVmToolbox("bob", binding)).rejects.toThrow(
    "Account changed",
  );
});
test("SSH setup uses structured argv then a bounded harmless passwordless probe", async () => {
  await prepareVmSsh(id, id);
  expect(mockWrite.mock.calls[0][0].content).toContain("Host existing");
  expect(mockWrite.mock.calls[0][0].content).toContain(`Host cocalc-vm-${id}`);
  expect(mockWrite.mock.calls[0][0].content).toContain(
    "IdentityFile ~/.ssh/id_ed25519",
  );
  expect(mockExec.mock.calls[1][0]).toEqual(
    expect.objectContaining({ command: "ssh", timeout: 20 }),
  );
  expect(mockExec.mock.calls[1][0].args).toContain("BatchMode=yes");
  expect(mockExec.mock.calls[1][0].args.at(-1)).toBe("true");
});

test("SSH setup rejects config injection and stopped machines before touching files", async () => {
  mockGetVm.mockResolvedValueOnce({
    state: "ready",
    public_hostname: "host\nProxyCommand bad",
    ssh_user: "user",
  });
  await expect(prepareVmSsh(id, id)).rejects.toThrow("Invalid VM SSH endpoint");
  mockGetVm.mockResolvedValueOnce({
    state: "stopped",
    public_hostname: "host",
    ssh_user: "user",
  });
  await expect(prepareVmSsh(id, id)).rejects.toThrow("not ready");
  expect(mockWrite).not.toHaveBeenCalled();
});
