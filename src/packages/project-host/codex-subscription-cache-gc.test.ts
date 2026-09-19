import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

describe("Codex subscription cache GC", () => {
  const accountId = "00000000-0000-4000-8000-000000000001";
  const activeCredentialId = "00000000-0000-4000-8000-000000000002";
  const staleCredentialId = "00000000-0000-4000-8000-000000000003";
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cache-gc-"));
    process.env.COCALC_CODEX_AUTH_SUBSCRIPTION_HOME_ROOT = root;
    const accountRoot = path.join(root, accountId);
    const activeHome = path.join(accountRoot, activeCredentialId);
    const staleHome = path.join(accountRoot, staleCredentialId);
    await fs.mkdir(activeHome, { recursive: true });
    await fs.mkdir(staleHome, { recursive: true });
    for (const file of [
      path.join(accountRoot, "auth.json"),
      path.join(accountRoot, ".last_used"),
      path.join(activeHome, ".last_used"),
      path.join(staleHome, ".last_used"),
    ]) {
      await fs.writeFile(file, "{}");
      const stale = new Date(Date.now() - 60_000);
      await fs.utimes(file, stale, stale);
    }
  });

  afterEach(async () => {
    delete process.env.COCALC_CODEX_AUTH_SUBSCRIPTION_HOME_ROOT;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("preserves an active credential while removing stale siblings", async () => {
    const { sweepCodexSubscriptionCacheOnce } =
      await import("./codex/codex-subscription-cache-gc");
    const activeHome = path.join(root, accountId, activeCredentialId);
    await sweepCodexSubscriptionCacheOnce(1, new Set([activeHome]));

    const accountRoot = path.join(root, accountId);
    await expect(
      fs.stat(path.join(accountRoot, activeCredentialId)),
    ).resolves.toBeDefined();
    await expect(
      fs.stat(path.join(accountRoot, staleCredentialId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(accountRoot, "auth.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
