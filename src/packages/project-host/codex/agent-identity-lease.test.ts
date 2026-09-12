import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentIdentityLease } from "./agent-identity-lease";

describe("separate runtime identity lease", () => {
  const old = process.env.COCALC_AGENT_MESSAGING_ENABLED;
  let dir: string;
  const issueIdentity = jest.fn(),
    endIdentityRun = jest.fn();
  const projectId = randomUUID(),
    accountId = randomUUID(),
    agent_id = randomUUID();
  const env = {
    COCALC_CODEX_CHAT_PATH: "/home/user/a.chat",
    COCALC_CODEX_THREAD_ID: randomUUID(),
    COCALC_BEARER_TOKEN: "broad-token-never-used",
  };
  beforeEach(async () => {
    process.env.COCALC_AGENT_MESSAGING_ENABLED = "1";
    dir = await mkdtemp(join(tmpdir(), "agent-identity-test-"));
    issueIdentity
      .mockReset()
      .mockImplementation(async ({ run_id }) => ({
        agent_id,
        run_id,
        token: "cocalc_agent_identity_test",
        expires_at: Date.now() + 600000,
      }));
    endIdentityRun.mockReset().mockResolvedValue(undefined);
  });
  afterEach(async () => {
    jest.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });
  afterAll(() => {
    if (old === undefined) delete process.env.COCALC_AGENT_MESSAGING_ENABLED;
    else process.env.COCALC_AGENT_MESSAGING_ENABLED = old;
  });
  const create = () =>
    createAgentIdentityLease({
      api: { issueIdentity, endIdentityRun },
      projectId,
      accountId,
      env,
      hostDir: dir,
    });
  test("off by default and no credential for an unregistered thread", async () => {
    delete process.env.COCALC_AGENT_MESSAGING_ENABLED;
    expect(await create()).toBeUndefined();
    expect(issueIdentity).not.toHaveBeenCalled();
    process.env.COCALC_AGENT_MESSAGING_ENABLED = "1";
    issueIdentity.mockResolvedValue(undefined);
    expect(await create()).toBeUndefined();
  });
  test("private file is attributable, renewed, and revoked on close", async () => {
    jest.useFakeTimers();
    const lease = (await create())!;
    const first = JSON.parse(await readFile(lease.hostPath, "utf8"));
    expect(first).toMatchObject({
      agent_id,
      token: "cocalc_agent_identity_test",
    });
    expect((await stat(lease.hostPath)).mode & 0o777).toBe(0o600);
    jest.advanceTimersByTime(180000);
    await lease.close();
    await lease.close();
    expect(issueIdentity).toHaveBeenCalledTimes(2);
    expect(issueIdentity.mock.calls[1][0].run_id).toBe(first.run_id);
    expect(endIdentityRun).toHaveBeenCalledTimes(1);
    expect(endIdentityRun).toHaveBeenCalledWith({
      account_id: accountId,
      agent_id,
      run_id: first.run_id,
    });
    await expect(stat(lease.hostPath)).rejects.toThrow();
  });
  test("issuance failure does not substitute broad project credentials", async () => {
    issueIdentity.mockRejectedValue(new Error("identity disabled"));
    await expect(create()).rejects.toThrow("identity disabled");
    await expect(stat(join(dir, "identity.json"))).rejects.toThrow();
  });
});
