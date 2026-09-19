import { EventEmitter } from "node:events";

const pushSubscriptionAuthToRegistryMock = jest.fn();
const acquireCodexDeviceAuthLeaseMock = jest.fn();
const releaseCodexDeviceAuthLeaseMock = jest.fn();
const spawnCodexInProjectContainerMock = jest.fn();
const resolveSubscriptionStagingHomeMock = jest.fn(
  (accountId: string, sessionId: string) =>
    `/tmp/codex-${accountId}/.pending/${sessionId}`,
);

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock("./codex/codex-auth-registry", () => ({
  acquireCodexDeviceAuthLease: (...args) =>
    acquireCodexDeviceAuthLeaseMock(...args),
  pushSubscriptionAuthToRegistry: (...args) =>
    pushSubscriptionAuthToRegistryMock(...args),
  releaseCodexDeviceAuthLease: (...args) =>
    releaseCodexDeviceAuthLeaseMock(...args),
}));

jest.mock("./codex/codex-subscription-cache-gc", () => ({
  touchSubscriptionCacheUsage: jest.fn(async () => undefined),
}));

jest.mock("./codex/codex-auth", () => ({
  ensureCodexAuthFileExists: jest.fn(async () => undefined),
  ensureCodexCredentialsStoreFile: jest.fn(async () => undefined),
  resolveSubscriptionStagingHome: (...args) =>
    resolveSubscriptionStagingHomeMock(...args),
  subscriptionRuntime: ({ projectId, accountId, codexHome }) => ({
    source: "subscription",
    contextId: `${projectId}:${accountId}`,
    codexHome,
    env: {},
  }),
}));

jest.mock("./codex/codex-project", () => ({
  spawnCodexInProjectContainer: (...args) =>
    spawnCodexInProjectContainerMock(...args),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = jest.fn();
}

describe("codex device auth", () => {
  beforeEach(() => {
    jest.resetModules();
    pushSubscriptionAuthToRegistryMock.mockReset();
    acquireCodexDeviceAuthLeaseMock.mockReset().mockResolvedValue("lease-1");
    releaseCodexDeviceAuthLeaseMock.mockReset().mockResolvedValue(undefined);
    resolveSubscriptionStagingHomeMock.mockClear();
    spawnCodexInProjectContainerMock.mockReset();
  });

  it("stages reconnect login outside the permanent credential cache", async () => {
    const proc = new FakeProc();
    spawnCodexInProjectContainerMock.mockResolvedValue({ proc });
    const { startCodexDeviceAuth } = await import("./codex/codex-device-auth");

    const started = await startCodexDeviceAuth(
      "00000000-0000-4000-8000-000000000010",
      "00000000-0000-4000-8000-000000000011",
      undefined,
      { credentialId: "00000000-0000-4000-8000-000000000012" },
    );

    expect(resolveSubscriptionStagingHomeMock).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000011",
      started.id,
    );
    expect(spawnCodexInProjectContainerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authRuntime: expect.objectContaining({
          codexHome: expect.stringContaining(`/.pending/${started.id}`),
        }),
      }),
    );
    proc.emit("exit", 1, null);
  });

  it("does not report completed until subscription auth is synced to registry", async () => {
    const sync = deferred<{ ok: boolean; id?: string }>();
    const proc = new FakeProc();
    spawnCodexInProjectContainerMock.mockResolvedValue({ proc });
    pushSubscriptionAuthToRegistryMock.mockReturnValue(sync.promise);
    const { startCodexDeviceAuth, getCodexDeviceAuthStatus } =
      await import("./codex/codex-device-auth");

    const started = await startCodexDeviceAuth("project-1", "account-1");
    expect(spawnCodexInProjectContainerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        execOnlyEnv: {
          CODEX_HOME: "/run/cocalc/codex-subscription",
        },
      }),
    );
    proc.emit("exit", 0, null);

    expect(getCodexDeviceAuthStatus(started.id)).toMatchObject({
      state: "syncing",
      syncedToRegistry: undefined,
    });

    sync.resolve({ ok: true, id: "cred-1" });
    await sync.promise;
    await Promise.resolve();

    expect(getCodexDeviceAuthStatus(started.id)).toMatchObject({
      state: "completed",
      syncedToRegistry: true,
    });
  });

  it("does not report completed until synced subscription auth is verified", async () => {
    const verification = deferred<void>();
    const proc = new FakeProc();
    spawnCodexInProjectContainerMock.mockResolvedValue({ proc });
    pushSubscriptionAuthToRegistryMock.mockResolvedValue({ ok: true });
    const { startCodexDeviceAuth, getCodexDeviceAuthStatus } =
      await import("./codex/codex-device-auth");

    const started = await startCodexDeviceAuth(
      "project-1",
      "account-1",
      () => verification.promise,
    );
    proc.emit("exit", 0, null);
    await Promise.resolve();

    expect(getCodexDeviceAuthStatus(started.id)).toMatchObject({
      state: "syncing",
      syncedToRegistry: true,
    });

    verification.resolve();
    await verification.promise;
    await Promise.resolve();

    expect(getCodexDeviceAuthStatus(started.id)).toMatchObject({
      state: "completed",
      syncedToRegistry: true,
    });
  });

  it("fails device auth when synced subscription auth cannot be verified", async () => {
    const proc = new FakeProc();
    spawnCodexInProjectContainerMock.mockResolvedValue({ proc });
    pushSubscriptionAuthToRegistryMock.mockResolvedValue({ ok: true });
    const { startCodexDeviceAuth, getCodexDeviceAuthStatus } =
      await import("./codex/codex-device-auth");

    const started = await startCodexDeviceAuth(
      "project-1",
      "account-1",
      async () => {
        throw Error("account/rateLimits/read: auth required");
      },
    );
    proc.emit("exit", 0, null);
    await Promise.resolve();
    await Promise.resolve();

    expect(getCodexDeviceAuthStatus(started.id)).toMatchObject({
      state: "failed",
      syncedToRegistry: true,
      syncError: "Error: account/rateLimits/read: auth required",
      error:
        "ChatGPT sign-in succeeded, but CoCalc could not verify that Codex can use the saved credential. Please try signing in again.",
    });
  });

  it("fails device auth when subscription auth cannot be synced to registry", async () => {
    const proc = new FakeProc();
    spawnCodexInProjectContainerMock.mockResolvedValue({ proc });
    pushSubscriptionAuthToRegistryMock.mockResolvedValue({ ok: false });
    const { startCodexDeviceAuth, getCodexDeviceAuthStatus } =
      await import("./codex/codex-device-auth");

    const started = await startCodexDeviceAuth("project-2", "account-2");
    proc.emit("exit", 0, null);
    await Promise.resolve();

    expect(getCodexDeviceAuthStatus(started.id)).toMatchObject({
      state: "failed",
      syncedToRegistry: false,
      syncError: "unable to sync credentials to central registry",
    });
  });
});
