import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const callHubMock = jest.fn();
const getMasterConatClientMock = jest.fn(() => ({ request: jest.fn() }));
const getLocalHostIdMock = jest.fn(() => "host-1");

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: (...args) => callHubMock(...args),
}));

jest.mock("./master-status", () => ({
  getMasterConatClient: () => getMasterConatClientMock(),
}));

jest.mock("./sqlite/hosts", () => ({
  getLocalHostId: () => getLocalHostIdMock(),
}));

describe("syncSubscriptionAuthToRegistryIfChanged", () => {
  let tempDirs: string[] = [];

  function mkTempDir(prefix: string) {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    tempDirs = [];
    callHubMock.mockReset();
    getMasterConatClientMock.mockClear();
    getLocalHostIdMock.mockClear();
    jest.resetModules();
  });

  afterEach(() => {
    for (const dir of tempDirs.reverse()) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pushes local auth once and skips unchanged content", async () => {
    const root = mkTempDir("cocalc-auth-sync-");
    writeFileSync(path.join(root, "auth.json"), '{"token":"one"}\n');

    callHubMock.mockResolvedValue({ id: "cred-1" });
    const { syncSubscriptionAuthToRegistryIfChanged } =
      await import("./codex/codex-auth-registry");

    await expect(
      syncSubscriptionAuthToRegistryIfChanged({
        projectId: "project-1",
        accountId: "account-1",
        codexHome: root,
      }),
    ).resolves.toEqual({
      ok: true,
      id: "cred-1",
      skipped: false,
    });
    await expect(
      syncSubscriptionAuthToRegistryIfChanged({
        projectId: "project-1",
        accountId: "account-1",
        codexHome: root,
      }),
    ).resolves.toEqual({
      ok: true,
      skipped: true,
    });
    expect(callHubMock).toHaveBeenCalledTimes(1);
  });

  it("pushes again after auth.json changes", async () => {
    const root = mkTempDir("cocalc-auth-sync-");
    const authPath = path.join(root, "auth.json");
    writeFileSync(authPath, '{"token":"one"}\n');

    callHubMock.mockResolvedValue({ id: "cred-1" });
    const { syncSubscriptionAuthToRegistryIfChanged } =
      await import("./codex/codex-auth-registry");

    await syncSubscriptionAuthToRegistryIfChanged({
      projectId: "project-2",
      accountId: "account-2",
      codexHome: root,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    writeFileSync(authPath, '{"token":"two"}\n');
    await expect(
      syncSubscriptionAuthToRegistryIfChanged({
        projectId: "project-2",
        accountId: "account-2",
        codexHome: root,
      }),
    ).resolves.toEqual({
      ok: true,
      id: "cred-1",
      skipped: false,
    });
    expect(callHubMock).toHaveBeenCalledTimes(2);
  });

  it("pulls registry auth when it is newer than local auth", async () => {
    const root = mkTempDir("cocalc-auth-pull-");
    const authPath = path.join(root, "auth.json");
    writeFileSync(authPath, '{"token":"old"}\n');
    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(authPath, oldTime, oldTime);

    callHubMock.mockResolvedValue({
      payload: '{"token":"new"}\n',
      updated: new Date().toISOString(),
    });
    const { pullSubscriptionAuthFromRegistry } =
      await import("./codex/codex-auth-registry");

    await expect(
      pullSubscriptionAuthFromRegistry({
        projectId: "project-3",
        accountId: "account-3",
        codexHome: root,
        onlyIfNewer: true,
      }),
    ).resolves.toMatchObject({
      pulled: true,
      source: "registry",
    });
    expect(readFileSync(authPath, "utf8")).toBe('{"token":"new"}\n');
  });

  it("keeps local auth when it is newer than registry auth", async () => {
    const root = mkTempDir("cocalc-auth-pull-");
    const authPath = path.join(root, "auth.json");
    writeFileSync(authPath, '{"token":"local"}\n');
    const newTime = new Date(Date.now() + 60_000);
    utimesSync(authPath, newTime, newTime);

    callHubMock.mockResolvedValue({
      payload: '{"token":"registry"}\n',
      updated: new Date().toISOString(),
    });
    const { pullSubscriptionAuthFromRegistry } =
      await import("./codex/codex-auth-registry");

    await expect(
      pullSubscriptionAuthFromRegistry({
        projectId: "project-4",
        accountId: "account-4",
        codexHome: root,
        onlyIfNewer: true,
      }),
    ).resolves.toMatchObject({
      pulled: false,
      skipped: "local-newer",
    });
    expect(readFileSync(authPath, "utf8")).toBe('{"token":"local"}\n');
  });
});
