import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  spawnLiteCodexAppServer,
  installLiteCodexSpawner,
} from "../../codex-runtime";
import {
  saveLiteCredential,
  revokeLiteCredential,
  listLiteCredentials,
} from "../../codex-credentials";
import { getCodexProjectSpawner, setCodexProjectSpawner } from "@cocalc/ai/acp";

const spawnMock = jest.fn();
jest.mock("node:child_process", () => ({
  spawn: (...args: any[]) => spawnMock(...args),
}));
jest.mock("../../settings", () => ({ getLiteServerSettings: () => ({}) }));

const owner = "local-account";
const auth = (account: string) =>
  JSON.stringify({
    tokens: { account_id: account, access_token: `private-token-${account}` },
  });

describe("Lite selected credential runtime", () => {
  let home: string;
  const oldHome = process.env.COCALC_CODEX_HOME;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "lite-codex-runtime-"));
    process.env.COCALC_CODEX_HOME = home;
    spawnMock.mockReset().mockReturnValue({});
    setCodexProjectSpawner(null);
  });
  afterEach(async () => {
    setCodexProjectSpawner(null);
    if (oldHome == null) delete process.env.COCALC_CODEX_HOME;
    else process.env.COCALC_CODEX_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  });

  it("runs concurrent explicit selections with distinct process logins, never a shared auth swap", async () => {
    await writeFile(join(home, "auth.json"), auth("legacy"));
    const a = saveLiteCredential(owner, auth("a"), { create: true });
    const b = saveLiteCredential(owner, auth("b"), { create: true });
    const opts = {
      projectId: "project",
      accountId: owner,
      paymentSource: "subscription-credential" as const,
    };
    const [first, second] = await Promise.all([
      spawnLiteCodexAppServer({ ...opts, credentialId: a }),
      spawnLiteCodexAppServer({ ...opts, credentialId: b }),
    ]);
    expect(first).toMatchObject({
      credentialId: a,
      appServerLogin: { accessToken: "private-token-a" },
    });
    expect(second).toMatchObject({
      credentialId: b,
      appServerLogin: { accessToken: "private-token-b" },
    });
    expect(await readFile(join(home, "auth.json"), "utf8")).toBe(
      auth("legacy"),
    );
    for (const [, args, { env }] of spawnMock.mock.calls) {
      expect(args).toContain('cli_auth_credentials_store="ephemeral"');
      expect(env.CODEX_HOME).toBe(home);
      expect(JSON.stringify({ args, env })).not.toContain("private-token-");
    }
    expect(
      listLiteCredentials(owner).find(({ id }) => id === a)?.last_used,
    ).toBeInstanceOf(Date);
  });

  it("rejects revoked selections both at spawn and when reusing a runtime", async () => {
    const a = saveLiteCredential(owner, auth("a"));
    saveLiteCredential(owner, auth("b"));
    const opts = {
      projectId: "project",
      accountId: owner,
      paymentSource: "subscription-credential" as const,
      credentialId: a,
    };
    const runtime = await spawnLiteCodexAppServer(opts);
    revokeLiteCredential(owner, a);
    await expect(runtime.validateSubscriptionCredential!()).rejects.toThrow(
      "unavailable",
    );
    await expect(spawnLiteCodexAppServer(opts)).rejects.toThrow("unavailable");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("rejects explicit subscription mode without an ID before spawning the default", async () => {
    saveLiteCredential(owner, auth("default"));
    await expect(
      spawnLiteCodexAppServer({
        projectId: "project",
        accountId: owner,
        paymentSource: "subscription-credential",
      }),
    ).rejects.toThrow("explicit ChatGPT subscription");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("uses the staged login only for verification and does not register it", async () => {
    await writeFile(join(home, "auth.json"), auth("staged"));
    const runtime = await spawnLiteCodexAppServer({
      projectId: "project",
      accountId: owner,
      codexHome: home,
      touchReason: false,
    });
    expect(runtime.appServerLogin).toMatchObject({
      accessToken: "private-token-staged",
    });
    expect(runtime.credentialId).toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("installs locally but never replaces the project-host spawner", () => {
    installLiteCodexSpawner();
    expect(getCodexProjectSpawner()?.spawnCodexAppServer).toBe(
      spawnLiteCodexAppServer,
    );
    const host = { spawnCodexExec: jest.fn() };
    setCodexProjectSpawner(host);
    installLiteCodexSpawner();
    expect(getCodexProjectSpawner()).toBe(host);
  });

  it("preserves CLI API-key login without importing a broken subscription", async () => {
    const raw = JSON.stringify({ OPENAI_API_KEY: "private-cli-key" });
    await writeFile(join(home, "auth.json"), raw);
    expect(listLiteCredentials(owner)).toEqual([]);
    const runtime = await spawnLiteCodexAppServer({
      projectId: "project",
      accountId: owner,
      paymentSource: "shared-home",
    });
    expect(runtime).toMatchObject({
      authSource: "shared-home",
      appServerLogin: { type: "apiKey", apiKey: "private-cli-key" },
    });
    expect(await readFile(join(home, "auth.json"), "utf8")).toBe(raw);
    expect(JSON.stringify(spawnMock.mock.calls)).not.toContain(
      "private-cli-key",
    );
  });
});
