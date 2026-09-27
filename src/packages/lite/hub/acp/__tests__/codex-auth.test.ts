import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const spawnMock = jest.fn();

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock("node:child_process", () => ({
  spawn: (...args: any[]) => spawnMock(...args),
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

describe("lite codex device auth", () => {
  let codexHome: string;

  beforeEach(async () => {
    jest.resetModules();
    spawnMock.mockReset();
    codexHome = await mkdtemp(join(tmpdir(), "cocalc-lite-codex-auth-"));
    process.env.COCALC_CODEX_HOME = codexHome;
  });

  afterEach(async () => {
    delete process.env.COCALC_CODEX_HOME;
    await rm(codexHome, { force: true, recursive: true });
  });

  it("does not report completed until local auth is verified", async () => {
    const verification = deferred<void>();
    const proc = new FakeProc();
    spawnMock.mockReturnValue(proc);
    const {
      startLiteCodexDeviceAuth,
      getLiteCodexDeviceAuthStatus,
      verifyLiteCodexDeviceAuthStatus,
    } = await import("../../codex-auth");

    const started = await startLiteCodexDeviceAuth({
      projectId: "project-1",
      accountId: "account-1",
    });
    await writeFile(
      join(started.codexHome, "auth.json"),
      JSON.stringify({
        tokens: { account_id: "chatgpt-1", access_token: "token-1" },
      }),
    );
    expect(started.codexHome).not.toBe(codexHome);
    expect(spawnMock.mock.calls[0][2].env.CODEX_HOME).toBe(started.codexHome);
    proc.emit("exit", 0, null);

    expect(getLiteCodexDeviceAuthStatus(started.id)).toMatchObject({
      state: "syncing",
      syncedToRegistry: undefined,
    });

    const verifying = verifyLiteCodexDeviceAuthStatus(
      started.id,
      () => verification.promise,
    );
    await Promise.resolve();

    expect(getLiteCodexDeviceAuthStatus(started.id)).toMatchObject({
      state: "syncing",
    });

    verification.resolve();
    await verifying;

    expect(getLiteCodexDeviceAuthStatus(started.id)).toMatchObject({
      state: "completed",
      syncedToRegistry: true,
    });
  });

  it("shares one local auth verification across concurrent status polls", async () => {
    const verification = deferred<void>();
    const proc = new FakeProc();
    const verifier = jest.fn(() => verification.promise);
    spawnMock.mockReturnValue(proc);
    const {
      startLiteCodexDeviceAuth,
      getLiteCodexDeviceAuthStatus,
      verifyLiteCodexDeviceAuthStatus,
    } = await import("../../codex-auth");

    const started = await startLiteCodexDeviceAuth({
      projectId: "project-1",
      accountId: "account-1",
    });
    await writeFile(
      join(started.codexHome, "auth.json"),
      JSON.stringify({
        tokens: { account_id: "chatgpt-1", access_token: "token-1" },
      }),
    );
    proc.emit("exit", 0, null);

    const first = verifyLiteCodexDeviceAuthStatus(started.id, verifier);
    const second = verifyLiteCodexDeviceAuthStatus(started.id, verifier);
    await Promise.resolve();

    expect(verifier).toHaveBeenCalledTimes(1);
    expect(getLiteCodexDeviceAuthStatus(started.id)).toMatchObject({
      state: "syncing",
    });

    verification.resolve();
    await Promise.all([first, second]);

    expect(getLiteCodexDeviceAuthStatus(started.id)).toMatchObject({
      state: "completed",
      syncedToRegistry: true,
    });
  });

  it("fails device auth when local auth cannot be verified", async () => {
    const proc = new FakeProc();
    spawnMock.mockReturnValue(proc);
    const { startLiteCodexDeviceAuth, verifyLiteCodexDeviceAuthStatus } =
      await import("../../codex-auth");

    const started = await startLiteCodexDeviceAuth({
      projectId: "project-1",
      accountId: "account-1",
    });
    proc.emit("exit", 0, null);

    const status = await verifyLiteCodexDeviceAuthStatus(
      started.id,
      async () => {
        throw Error("account/rateLimits/read: auth required");
      },
    );

    expect(status).toMatchObject({
      state: "failed",
      syncedToRegistry: false,
      syncError: "Error: account/rateLimits/read: auth required",
      error:
        "ChatGPT sign-in succeeded, but CoCalc could not verify that Codex can use the saved credential. Please try signing in again.",
    });
  });

  it("adds without changing the legacy file and reconnects only its target", async () => {
    const original = JSON.stringify({
      tokens: { account_id: "legacy", access_token: "original" },
    });
    await writeFile(join(codexHome, "auth.json"), original);
    const proc = new FakeProc();
    spawnMock.mockReturnValue(proc);
    const auth = await import("../../codex-auth");
    const registry = await import("../../codex-credentials");
    const added = await auth.startLiteCodexDeviceAuth({
      projectId: "project-1",
      accountId: "account-1",
      create: true,
    });
    await writeFile(
      join(added.codexHome, "auth.json"),
      JSON.stringify({
        tokens: { account_id: "other", access_token: "second" },
      }),
    );
    proc.emit("exit", 0, null);
    const completed = await auth.verifyLiteCodexDeviceAuthStatus(
      added.id,
      async () => {},
    );
    expect(completed).toMatchObject({
      state: "completed",
      registryCreated: true,
    });
    expect(registry.listLiteCredentials("account-1")).toHaveLength(2);
    expect(await readFile(join(codexHome, "auth.json"), "utf8")).toBe(original);
    const reconnected = await auth.startLiteCodexDeviceAuth({
      projectId: "project-1",
      accountId: "account-1",
      credentialId: completed!.credentialId,
    });
    await writeFile(
      join(reconnected.codexHome, "auth.json"),
      JSON.stringify({
        tokens: { account_id: "other", access_token: "updated" },
      }),
    );
    proc.emit("exit", 0, null);
    await auth.verifyLiteCodexDeviceAuthStatus(reconnected.id, async () => {});
    expect(
      registry.getLiteCredential("account-1", completed!.credentialId).login
        .accessToken,
    ).toBe("updated");
    expect(registry.listLiteCredentials("account-1")).toHaveLength(2);
  });

  it("cancel during verification never saves the staged credential", async () => {
    const proc = new FakeProc();
    spawnMock.mockReturnValue(proc);
    const auth = await import("../../codex-auth");
    const registry = await import("../../codex-credentials");
    const started = await auth.startLiteCodexDeviceAuth({
      projectId: "project-1",
      accountId: "account-1",
      create: true,
    });
    const verification = deferred<void>();
    proc.emit("exit", 0, null);
    const checking = auth.verifyLiteCodexDeviceAuthStatus(
      started.id,
      () => verification.promise,
    );
    expect(auth.cancelLiteCodexDeviceAuth(started.id)).toBe(true);
    verification.resolve();
    expect(await checking).toMatchObject({ state: "canceled" });
    expect(registry.listLiteCredentials("account-1")).toEqual([]);
  });
});
