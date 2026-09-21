import {
  discoverHarnessControls,
  drainHarnessDiscovery,
  pauseHarnessDiscovery,
  setHarnessLauncher,
} from "../harness-runtime";
import { AcpHarnessClient, disposeFailedHarness } from "@cocalc/ai/acp/harness";
import type { AcpRequest } from "@cocalc/conat/ai/acp/types";

jest.mock("@cocalc/ai/acp/harness", () => ({
  AcpHarnessClient: { start: jest.fn() },
  disposeFailedHarness: jest.fn(),
}));

const request: AcpRequest = {
  project_id: "project",
  account_id: "account",
  prompt: "never send this",
  session_id: "existing-session-must-not-be-loaded",
  chat: { project_id: "project", path: "a.chat", thread_id: "thread" } as any,
  runtime: {
    version: 1,
    kind: "acp",
    profile: {
      version: 1,
      kind: "acp",
      id: "fixture",
      revision: "1",
      executable: "/home/user/fixture",
      args: [],
      cwd: "/home/user",
      executionPolicy: "full-access",
      credentialMode: "project-managed",
    },
    settings: { modeId: "code" },
  },
};
const original = process.env.COCALC_ACP_HARNESSES;
let client: any;
let launch: jest.Mock;
beforeEach(() => {
  process.env.COCALC_ACP_HARNESSES = "1";
  client = {
    open: jest.fn(),
    configure: jest.fn(),
    dispose: jest.fn(),
    prompt: jest.fn(),
    controls: { configOptions: [] },
  };
  launch = jest.fn(async () => ({}));
  setHarnessLauncher(launch);
  (disposeFailedHarness as jest.Mock).mockImplementation(
    async (error, dispose) => {
      await dispose();
      throw error;
    },
  );
  (AcpHarnessClient.start as jest.Mock).mockImplementation(
    async (binding, launcher) => {
      await launcher(binding);
      return client;
    },
  );
});
afterEach(() => {
  setHarnessLauncher();
  if (original === undefined) delete process.env.COCALC_ACP_HARNESSES;
  else process.env.COCALC_ACP_HARNESSES = original;
  jest.clearAllMocks();
});

test("discovery opens a temporary session without a prompt or existing session ID", async () => {
  expect(await discoverHarnessControls(request)).toEqual({
    profile: request.runtime!.profile,
    controls: client.controls,
  });
  expect(launch).toHaveBeenCalledWith(
    {
      projectId: "project",
      accountId: "account",
      profile: request.runtime!.profile,
    },
    { path: "a.chat", threadId: "thread" },
  );
  expect(client.open).toHaveBeenCalledWith();
  expect(client.configure).toHaveBeenCalledWith({ modeId: "code" });
  expect(client.prompt).not.toHaveBeenCalled();
  expect(client.dispose).toHaveBeenCalledTimes(1);
});

test.each(["open", "configure"])(
  "%s failure cleans up and releases the discovery slot",
  async (method) => {
    client[method].mockRejectedValueOnce(Error("fixture failure"));
    await expect(discoverHarnessControls(request)).rejects.toThrow(
      "fixture failure",
    );
    expect(client.dispose).toHaveBeenCalledTimes(1);
    await expect(discoverHarnessControls(request)).resolves.toBeDefined();
  },
);

test("setup and cleanup failure use the shared classifier and release the slot", async () => {
  const primary = Error("session rejected");
  const classified = Error("classified cleanup failure");
  client.open.mockRejectedValueOnce(primary);
  client.dispose.mockRejectedValueOnce(Error("stop failed"));
  (disposeFailedHarness as jest.Mock).mockImplementationOnce(
    async (error, dispose) => {
      expect(error).toBe(primary);
      await expect(dispose()).rejects.toThrow("stop failed");
      throw classified;
    },
  );
  await expect(discoverHarnessControls(request)).rejects.toBe(classified);
  expect(disposeFailedHarness).toHaveBeenCalledTimes(1);
  expect(client.dispose).toHaveBeenCalledTimes(1);
  await expect(discoverHarnessControls(request)).resolves.toBeDefined();
});

test("cleanup failure after successful discovery does not return controls or hold the slot", async () => {
  client.dispose.mockRejectedValueOnce(Error("stop failed"));
  await expect(discoverHarnessControls(request)).rejects.toThrow("stop failed");
  expect(disposeFailedHarness).not.toHaveBeenCalled();
  await expect(discoverHarnessControls(request)).resolves.toBeDefined();
});

test("duplicate discovery cannot launch a second process", async () => {
  let release!: () => void;
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  client.open.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
        opened();
      }),
  );
  const first = discoverHarnessControls(request);
  await expect(discoverHarnessControls(request)).rejects.toThrow("busy");
  await ready;
  let drained = false;
  const draining = drainHarnessDiscovery("project").then(() => {
    drained = true;
  });
  await drainHarnessDiscovery("other-project");
  expect(drained).toBe(false);
  release();
  await first;
  await draining;
  expect(drained).toBe(true);
  expect(launch).toHaveBeenCalledTimes(1);
});

test("disabled discovery never launches and never falls back to Codex", async () => {
  delete process.env.COCALC_ACP_HARNESSES;
  await expect(discoverHarnessControls(request)).rejects.toThrow("not enabled");
  expect(launch).not.toHaveBeenCalled();
});

test("project stop blocks later discovery until container removal finishes", async () => {
  let release!: () => void;
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  client.open.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
        opened();
      }),
  );
  const first = discoverHarnessControls(request);
  await ready;
  const resume = pauseHarnessDiscovery("project");
  try {
    const draining = drainHarnessDiscovery("project");
    await expect(discoverHarnessControls(request)).rejects.toThrow("stopping");
    release();
    await first;
    await draining;
    // The drain has finished, but the primary container is still being removed.
    await expect(discoverHarnessControls(request)).rejects.toThrow("stopping");
    expect(launch).toHaveBeenCalledTimes(1);
  } finally {
    release();
    resume();
  }
  await expect(discoverHarnessControls(request)).resolves.toBeDefined();
});

test("discovery pauses are project scoped, nested and idempotently released", async () => {
  const outer = pauseHarnessDiscovery("project");
  const inner = pauseHarnessDiscovery("project");
  try {
    await expect(
      discoverHarnessControls({
        ...request,
        project_id: "other",
        chat: { ...request.chat!, project_id: "other" },
      }),
    ).resolves.toBeDefined();
    inner();
    inner();
    await expect(discoverHarnessControls(request)).rejects.toThrow("stopping");
  } finally {
    inner();
    outer();
  }
  await expect(discoverHarnessControls(request)).resolves.toBeDefined();
});
