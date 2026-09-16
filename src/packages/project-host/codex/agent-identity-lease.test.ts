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
    issueIdentity.mockReset().mockImplementation(async ({ run_id }) => ({
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
  test("turn preparation propagates renewal failure and can retry", async () => {
    const lease = (await create())!;
    try {
      issueIdentity.mockRejectedValueOnce(new Error("access revoked"));
      await expect(lease.refresh()).rejects.toThrow("access revoked");
      issueIdentity.mockResolvedValueOnce(undefined);
      await expect(lease.refresh()).rejects.toThrow(
        "registered identity unavailable",
      );
      await lease.refresh();
      expect(issueIdentity).toHaveBeenCalledTimes(4);
    } finally {
      await lease.close();
    }
  });
  test("an expired lease recovers with a new run after current authority is rechecked", async () => {
    const lease = (await create())!;
    const expiredRunId = issueIdentity.mock.calls[0][0].run_id;
    issueIdentity.mockRejectedValueOnce(
      new Error("calling remote function: agent_identity_run_expired"),
    );
    await lease.refresh();
    const recovery = issueIdentity.mock.calls[2][0];
    expect(recovery.run_id).not.toBe(expiredRunId);
    expect(recovery.recover_expired_run_id).toBe(expiredRunId);
    await lease.refresh();
    expect(issueIdentity.mock.calls[3][0]).toMatchObject({
      run_id: recovery.run_id,
    });
    await lease.close();
    expect(endIdentityRun).toHaveBeenCalledWith({
      account_id: accountId,
      agent_id,
      run_id: recovery.run_id,
    });
  });
  test("concurrent refreshes share issuance and close waits for it", async () => {
    const lease = (await create())!;
    let finish!: (value: any) => void;
    issueIdentity.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = lease.refresh();
    expect(lease.refresh()).toBe(first);
    const closing = lease.close();
    finish({ agent_id, token: "renewed", expires_at: Date.now() + 600000 });
    await first;
    await closing;
    expect(issueIdentity).toHaveBeenCalledTimes(2);
    expect(endIdentityRun).toHaveBeenCalledTimes(1);
    await expect(stat(lease.hostPath)).rejects.toThrow();
    await expect(lease.refresh()).rejects.toThrow("identity lease closed");
  });
});
