import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  getLiteCredential,
  listLiteCredentials,
  refreshLiteCredential,
  renameLiteCredential,
  revokeLiteCredential,
  saveLiteCredential,
  resolveLiteCodexHome,
} from "../../codex-credentials";
import { getLiteCodexPaymentSource } from "../../codex-payment";

jest.mock("../../settings", () => ({ getLiteServerSettings: () => ({}) }));

const owner = "local-account";
const auth = (account: string, token = account) =>
  JSON.stringify({
    tokens: {
      account_id: account,
      access_token: token,
      refresh_token: `refresh-${account}`,
    },
  });

describe("Lite subscription registry", () => {
  let home: string;
  const oldHome = process.env.COCALC_CODEX_HOME;
  const oldFetch = globalThis.fetch;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "lite-credentials-"));
    process.env.COCALC_CODEX_HOME = home;
  });
  afterEach(async () => {
    if (oldHome == null) delete process.env.COCALC_CODEX_HOME;
    else process.env.COCALC_CODEX_HOME = oldHome;
    globalThis.fetch = oldFetch;
    await rm(home, { recursive: true, force: true });
  });

  it("honors CoCalc override, inherited CODEX_HOME, then original HOME", () => {
    const env = { ...process.env };
    try {
      process.env.COCALC_CODEX_HOME = home;
      process.env.CODEX_HOME = "/inherited/codex";
      process.env.COCALC_ORIGINAL_HOME = "/original";
      process.env.HOME = "/temporary";
      expect(resolveLiteCodexHome()).toBe(home);
      delete process.env.COCALC_CODEX_HOME;
      expect(resolveLiteCodexHome()).toBe("/inherited/codex");
      delete process.env.CODEX_HOME;
      expect(resolveLiteCodexHome()).toBe("/original/.codex");
      delete process.env.COCALC_ORIGINAL_HOME;
      expect(resolveLiteCodexHome()).toBe("/temporary/.codex");
    } finally {
      process.env = env;
    }
  });

  it("migrates once, preserves auth.json, and never resurrects a revoked import", async () => {
    await writeFile(join(home, "auth.json"), auth("original"));
    const [first] = listLiteCredentials(owner);
    expect(first.metadata?.cocalc_default).toBe(true);
    expect(listLiteCredentials(owner).map(({ id }) => id)).toEqual([first.id]);
    const added = saveLiteCredential(owner, auth("second"), { create: true });
    expect(added).not.toBe(first.id);
    expect(await readFile(join(home, "auth.json"), "utf8")).toBe(
      auth("original"),
    );
    revokeLiteCredential(owner, first.id);
    expect(listLiteCredentials(owner).map(({ id }) => id)).toEqual([added]);
    expect(() => getLiteCredential(owner, first.id)).toThrow("unavailable");
    expect((await stat(join(home, "cocalc-subscriptions"))).mode & 0o777).toBe(
      0o700,
    );
    expect(
      (await stat(join(home, "cocalc-subscriptions", "credentials.sqlite3")))
        .mode & 0o777,
    ).toBe(0o600);
  });

  it("durably adds, reconnects, renames and lists without exposing tokens", () => {
    const a = saveLiteCredential(owner, auth("a"), { create: true });
    const b = saveLiteCredential(owner, auth("b"), { create: true });
    const before = getLiteCredential(owner, a).revision;
    renameLiteCredential(owner, a, "Personal");
    expect(getLiteCredential(owner, a).revision).toBe(before);
    expect(
      saveLiteCredential(owner, auth("a", "private-access-token"), {
        credentialId: a,
      }),
    ).toBe(a);
    expect(getLiteCredential(owner, a).revision).not.toBe(before);
    expect(getLiteCredential(owner, b).login.accessToken).toBe("b");
    const listed = listLiteCredentials(owner);
    expect(listed).toHaveLength(2);
    expect(listed.find(({ id }) => id === a)?.metadata?.label).toBe("Personal");
    expect(JSON.stringify(listed)).not.toMatch(
      /access_token|refresh_token|payload/,
    );
    expect(JSON.stringify(listed)).not.toContain("private-access-token");
  });

  it("restores records, labels and revocations in a fresh process", async () => {
    const a = saveLiteCredential(owner, auth("a"));
    const b = saveLiteCredential(owner, auth("b"));
    renameLiteCredential(owner, a, "Persisted label");
    revokeLiteCredential(owner, b);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "-e",
        `
      const { listLiteCredentials } = require(${JSON.stringify(join(__dirname, "../../../dist/hub/codex-credentials.js"))});
      process.stdout.write(JSON.stringify(listLiteCredentials(${JSON.stringify(owner)})));
    `,
      ],
      { env: { ...process.env } },
    );
    expect(JSON.parse(stdout)).toMatchObject([
      { id: a, metadata: { label: "Persisted label" } },
    ]);
    expect(JSON.parse(stdout)).toHaveLength(1);
    expect(stdout).not.toMatch(/refresh_token|access_token|payload/);
  });

  it("rejects invalid, ambiguous, wrong-account and revoked reconnects", () => {
    const a = saveLiteCredential(owner, auth("a"), { create: true });
    expect(() =>
      saveLiteCredential(owner, auth("a"), { create: true }),
    ).toThrow("already connected");
    expect(() => saveLiteCredential(owner, "{}", { create: true })).toThrow(
      "usable",
    );
    expect(() =>
      saveLiteCredential(owner, auth("a"), { create: true, credentialId: a }),
    ).toThrow("not both");
    expect(() =>
      saveLiteCredential(owner, auth("b"), { credentialId: a }),
    ).toThrow("same ChatGPT account");
    expect(() =>
      saveLiteCredential("other-owner", auth("a"), { credentialId: a }),
    ).toThrow("unavailable");
    expect(renameLiteCredential("other-owner", a, "Wrong")).toBe(false);
    expect(revokeLiteCredential("other-owner", a)).toBe(false);
    revokeLiteCredential(owner, a);
    expect(() =>
      saveLiteCredential(owner, auth("a"), { credentialId: a }),
    ).toThrow("unavailable");
  });

  it("keeps a revoked default tombstone instead of implicitly switching subscriptions", async () => {
    const a = saveLiteCredential(owner, auth("a"));
    const b = saveLiteCredential(owner, auth("b"));
    revokeLiteCredential(owner, a);
    const payment = await getLiteCodexPaymentSource({
      account_id: owner,
      preference: "subscription",
    });
    expect(payment).toMatchObject({ source: "none", credentialId: undefined });
    expect(payment.subscriptions).toEqual([
      expect.objectContaining({ id: b, isDefault: false }),
    ]);
    expect(() => getLiteCredential(owner)).toThrow("unavailable");
    await expect(
      getLiteCodexPaymentSource({
        account_id: owner,
        preference: "subscription-credential",
      }),
    ).rejects.toThrow("explicit");
  });

  it("keeps legacy uploads additive and explicit selections fail closed", async () => {
    const a = saveLiteCredential(owner, auth("a"));
    const b = saveLiteCredential(owner, auth("b"));
    expect(listLiteCredentials(owner)).toHaveLength(2);
    expect(
      await getLiteCodexPaymentSource({
        account_id: owner,
        preference: "subscription",
        credential_id: b,
      }),
    ).toMatchObject({ source: "subscription", credentialId: b });
    revokeLiteCredential(owner, b);
    expect(
      await getLiteCodexPaymentSource({
        account_id: owner,
        preference: "subscription",
        credential_id: b,
      }),
    ).toMatchObject({ source: "none", credentialId: undefined });
    expect(
      await getLiteCodexPaymentSource({ account_id: owner }),
    ).toMatchObject({ credentialId: a });
  });

  it("coalesces concurrent refreshes and retains the rotated token", async () => {
    const id = saveLiteCredential(owner, auth("a"));
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: "rotated",
        refresh_token: "rotated-refresh",
      }),
    }));
    globalThis.fetch = fetchMock as any;
    const [first, second] = await Promise.all([
      refreshLiteCredential(owner, id, "a"),
      refreshLiteCredential(owner, id, "a"),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.accessToken).toBe("rotated");
    expect(second.accessToken).toBe("rotated");
    expect(getLiteCredential(owner, id).login.accessToken).toBe("rotated");
  });

  it.each(["reconnect", "revoke"])(
    "does not undo a concurrent %s during refresh",
    async (action) => {
      const id = saveLiteCredential(owner, auth("a"));
      globalThis.fetch = jest.fn(async () => {
        if (action === "revoke") revokeLiteCredential(owner, id);
        else
          saveLiteCredential(owner, auth("a", "reconnected"), {
            credentialId: id,
          });
        return {
          ok: true,
          json: async () => ({ access_token: "late-refresh" }),
        };
      }) as any;
      if (action === "revoke") {
        await expect(refreshLiteCredential(owner, id, "a")).rejects.toThrow(
          "unavailable",
        );
      } else {
        expect((await refreshLiteCredential(owner, id, "a")).accessToken).toBe(
          "reconnected",
        );
      }
    },
  );
});
