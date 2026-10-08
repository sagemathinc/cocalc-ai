/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let requireDangerousSessionAuthMock: jest.Mock;
let upsertExternalCredentialMock: jest.Mock;
let getExternalCredentialMock: jest.Mock;
let revokeExternalCredentialMock: jest.Mock;
let listMock: jest.Mock;

jest.mock("./dangerous-session-auth", () => ({
  __esModule: true,
  requireDangerousSessionAuth: (...args: any[]) =>
    requireDangerousSessionAuthMock(...args),
}));

jest.mock("@cocalc/server/external-credentials/routing", () => ({
  __esModule: true,
  getExternalCredentialRouted: (...args: any[]) =>
    getExternalCredentialMock(...args),
  hasExternalCredentialRouted: jest.fn(async () => false),
  listAccountExternalCredentialsRouted: (...args: any[]) => listMock(...args),
  revokeAccountExternalCredentialRouted: (...args: any[]) =>
    revokeExternalCredentialMock(...args),
  revokeExternalCredentialBySelectorRouted: (...args: any[]) =>
    revokeExternalCredentialMock(...args),
  upsertExternalCredentialRouted: (...args: any[]) =>
    upsertExternalCredentialMock(...args),
}));

describe("external credential dangerous-session auth", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    requireDangerousSessionAuthMock = jest.fn(async () => {
      throw Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      });
    });
    upsertExternalCredentialMock = jest.fn(async () => ({
      id: "credential-1",
      created: true,
    }));
    getExternalCredentialMock = jest.fn(async () => ({
      id: "credential-1",
    }));
    revokeExternalCredentialMock = jest.fn(async () => true);
    listMock = jest.fn(async () => []);
  });

  it("requires fresh auth before storing an account OpenAI API key", async () => {
    const { setOpenAiApiKey } = await import("./system");

    await expect(
      setOpenAiApiKey({
        account_id: ACCOUNT_ID,
        browser_id: "browser-1",
        api_key: "sk-test",
      }),
    ).rejects.toThrow("fresh auth is required");

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: undefined,
      require_second_factor: false,
    });
    expect(upsertExternalCredentialMock).not.toHaveBeenCalled();
  });

  it("requires fresh auth before deleting an existing account OpenAI API key", async () => {
    const { deleteOpenAiApiKey } = await import("./system");

    await expect(
      deleteOpenAiApiKey({
        account_id: ACCOUNT_ID,
        session_hash: "session-hash",
      }),
    ).rejects.toThrow("fresh auth is required");

    expect(getExternalCredentialMock).toHaveBeenCalled();
    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: undefined,
      session_hash: "session-hash",
      require_second_factor: false,
    });
    expect(revokeExternalCredentialMock).not.toHaveBeenCalled();
  });

  it("does not require fresh auth when there is no account OpenAI API key to delete", async () => {
    getExternalCredentialMock = jest.fn(async () => undefined);
    const { deleteOpenAiApiKey } = await import("./system");

    await expect(
      deleteOpenAiApiKey({
        account_id: ACCOUNT_ID,
      }),
    ).resolves.toEqual({ revoked: false, scope: "account" });

    expect(requireDangerousSessionAuthMock).not.toHaveBeenCalled();
    expect(revokeExternalCredentialMock).not.toHaveBeenCalled();
  });

  it("requires fresh auth before revoking a generic external credential", async () => {
    const { revokeExternalCredential } = await import("./system");

    await expect(
      revokeExternalCredential({
        account_id: ACCOUNT_ID,
        browser_id: "browser-1",
        id: "credential-1",
      }),
    ).rejects.toThrow("fresh auth is required");

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: undefined,
      require_second_factor: false,
    });
    expect(revokeExternalCredentialMock).not.toHaveBeenCalled();
  });

  it.each([
    "github-token-cleanup",
    "github-cli-connection",
    "cloudflare-oauth-login",
  ])(
    "refuses to revoke connector credential %s outside Disconnect",
    async (kind) => {
      requireDangerousSessionAuthMock = jest.fn(async () => undefined);
      listMock = jest.fn(async () => [
        { id: "credential-1", provider: "github", kind },
      ]);
      const { revokeExternalCredential } = await import("./system");
      await expect(
        revokeExternalCredential({
          account_id: ACCOUNT_ID,
          id: "credential-1",
        }),
      ).rejects.toThrow("Settings > Connectors");
      expect(revokeExternalCredentialMock).not.toHaveBeenCalled();
    },
  );

  it("still revokes other credentials, and lists only them", async () => {
    requireDangerousSessionAuthMock = jest.fn(async () => undefined);
    listMock = jest.fn(async () => [
      { id: "credential-1", provider: "openai", kind: "openai-api-key" },
      { id: "credential-2", provider: "github", kind: "github-cli-connection" },
    ]);
    const { revokeExternalCredential, listExternalCredentials } =
      await import("./system");
    await expect(
      revokeExternalCredential({ account_id: ACCOUNT_ID, id: "credential-1" }),
    ).resolves.toEqual({ revoked: true });
    expect(
      (await listExternalCredentials({ account_id: ACCOUNT_ID })).map(
        ({ id }) => id,
      ),
    ).toEqual(["credential-1"]);
  });
});
