import { EventEmitter } from "node:events";

const pushSubscriptionAuthToRegistryMock = jest.fn();
const spawnCodexInProjectContainerMock = jest.fn();

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
  pushSubscriptionAuthToRegistry: (...args) =>
    pushSubscriptionAuthToRegistryMock(...args),
}));

jest.mock("./codex/codex-subscription-cache-gc", () => ({
  touchSubscriptionCacheUsage: jest.fn(async () => undefined),
}));

jest.mock("./codex/codex-auth", () => ({
  ensureCodexAuthFileExists: jest.fn(async () => undefined),
  ensureCodexCredentialsStoreFile: jest.fn(async () => undefined),
  resolveSubscriptionCodexHome: (accountId: string) =>
    `/tmp/codex-${accountId}`,
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
    spawnCodexInProjectContainerMock.mockReset();
  });

  it("does not report completed until subscription auth is synced to registry", async () => {
    const sync = deferred<{ ok: boolean; id?: string }>();
    const proc = new FakeProc();
    spawnCodexInProjectContainerMock.mockResolvedValue({ proc });
    pushSubscriptionAuthToRegistryMock.mockReturnValue(sync.promise);
    const { startCodexDeviceAuth, getCodexDeviceAuthStatus } =
      await import("./codex/codex-device-auth");

    const started = await startCodexDeviceAuth("project-1", "account-1");
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
