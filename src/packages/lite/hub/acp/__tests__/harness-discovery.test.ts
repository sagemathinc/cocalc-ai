import {
  discoverHarnessControls,
  forkHarnessSession,
  drainHarnessDiscovery,
  pauseHarnessDiscovery,
  setHarnessLauncher,
  setHarnessAuthorityValidator,
} from "../harness-runtime";
import { AcpHarnessClient, disposeFailedHarness } from "@cocalc/ai/acp/harness";
import type { AcpRequest } from "@cocalc/conat/ai/acp/types";
import { CLAUDE_CODE_QUALIFICATION } from "@cocalc/util/ai/qualified-harnesses";

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
    fork: jest.fn().mockResolvedValue({ sessionId: "copy" }),
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
  setHarnessAuthorityValidator();
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
      credential: {
        version: 1,
        provider: "project",
        mode: "project-managed",
      },
      profile: request.runtime!.profile,
    },
    { path: "a.chat", threadId: "thread" },
  );
  expect(client.open).toHaveBeenCalledWith();
  expect(client.configure).not.toHaveBeenCalled();
  expect(client.prompt).not.toHaveBeenCalled();
  expect(client.dispose).toHaveBeenCalledTimes(1);
});

test("fork clones native context without loading or configuring the source", async () => {
  expect(await forkHarnessSession(request)).toEqual({ sessionId: "copy" });
  expect(client.fork).toHaveBeenCalledWith(request.session_id);
  expect(client.open).not.toHaveBeenCalled();
  expect(client.configure).not.toHaveBeenCalled();
  expect(client.prompt).not.toHaveBeenCalled();
  expect(client.dispose).toHaveBeenCalledTimes(1);
});

test("fork requires a source and shares project-stop admission fencing", async () => {
  await expect(
    forkHarnessSession({ ...request, session_id: undefined }),
  ).rejects.toThrow("no saved context");
  const resume = pauseHarnessDiscovery(request.project_id);
  try {
    await expect(forkHarnessSession(request)).rejects.toThrow("stopping");
    expect(launch).not.toHaveBeenCalled();
  } finally {
    resume();
  }
});

test("failed forks clean up without falling back to an empty session", async () => {
  client.fork.mockRejectedValueOnce(Error("unsupported"));
  await expect(forkHarnessSession(request)).rejects.toThrow("unsupported");
  expect(client.dispose).toHaveBeenCalledTimes(1);
  expect(client.open).not.toHaveBeenCalled();
  expect(client.prompt).not.toHaveBeenCalled();
});

test("revoked fork authority never launches a controller", async () => {
  setHarnessAuthorityValidator(async () => {
    throw Error("revoked");
  });
  await expect(forkHarnessSession(request)).rejects.toThrow("revoked");
  expect(launch).not.toHaveBeenCalled();
  expect(client.fork).not.toHaveBeenCalled();
});

test("forks stay in the discovery drain until cleanup finishes", async () => {
  let release!: () => void;
  client.fork.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ sessionId: "copy" });
      }),
  );
  const first = forkHarnessSession(request);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  let drained = false;
  const drain = drainHarnessDiscovery(request.project_id).then(() => {
    drained = true;
  });
  expect(drained).toBe(false);
  await expect(forkHarnessSession(request)).rejects.toThrow("busy");
  release();
  await first;
  await drain;
  expect(drained).toBe(true);
});

test.each(["account-api-key", "account-subscription"] as const)(
  "discovery uses the selected %s rather than the project secret",
  async (mode) => {
    const credential = {
      version: 1 as const,
      provider: "anthropic" as const,
      mode,
      credentialId: "00000000-0000-4000-8000-000000000001",
    };
    await discoverHarnessControls({
      ...request,
      harness_credential: credential,
      runtime: {
        version: 1,
        kind: "acp",
        profile: {
          version: 2,
          kind: "acp",
          id: "claude-code",
          revision: CLAUDE_CODE_QUALIFICATION.package.version,
          cwd: "/home/user",
          executionPolicy: "full-access",
          credentialMode: "project-managed",
        },
      },
    });
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ credential }),
      { path: "a.chat", threadId: "thread" },
    );
    expect(client.prompt).not.toHaveBeenCalled();
    expect(client.dispose).toHaveBeenCalledTimes(1);
    await forkHarnessSession({
      ...request,
      harness_credential: credential,
      runtime: {
        version: 1,
        kind: "acp",
        profile: {
          version: 2,
          kind: "acp",
          id: "claude-code",
          revision: CLAUDE_CODE_QUALIFICATION.package.version,
          cwd: "/home/user",
          executionPolicy: "full-access",
          credentialMode: "project-managed",
        },
      },
    });
    expect(AcpHarnessClient.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ credential }),
      expect.any(Function),
      30_000,
      undefined,
      mode === "account-subscription"
        ? "claude-subscription-controller"
        : "default",
    );
  },
);

test("open failure cleans up and releases the discovery slot", async () => {
  client.open.mockRejectedValueOnce(Error("fixture failure"));
  await expect(discoverHarnessControls(request)).rejects.toThrow(
    "fixture failure",
  );
  expect(client.dispose).toHaveBeenCalledTimes(1);
  await expect(discoverHarnessControls(request)).resolves.toBeDefined();
});

test("discovery returns a fresh catalog even when saved model and effort are unavailable", async () => {
  const settings = {
    modeId: "removed-mode",
    configOptions: [
      { id: "model", value: "opus[1m]" },
      { id: "effort", value: "removed-effort" },
    ],
  };
  client.configure.mockRejectedValue(Error("Saved model is not advertised"));
  client.controls = {
    configOptions: [
      {
        id: "model",
        currentValue: "opus",
        options: [{ value: "opus", name: "Opus" }],
      },
    ],
  };
  const result = await discoverHarnessControls({
    ...request,
    runtime: { ...request.runtime!, settings },
  });
  expect(result.controls).toEqual(client.controls);
  expect(settings.configOptions[0].value).toBe("opus[1m]");
  expect(client.configure).not.toHaveBeenCalled();
  expect(client.open).toHaveBeenCalledWith();
  expect(client.prompt).not.toHaveBeenCalled();
  expect(client.dispose).toHaveBeenCalledTimes(1);
});

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
