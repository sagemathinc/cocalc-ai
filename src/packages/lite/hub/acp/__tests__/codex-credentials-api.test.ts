import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubApi } from "../../api";
import { project_id } from "@cocalc/project/data";
import { FALLBACK_PROJECT_UUID } from "@cocalc/util/misc";
import { pinCodexCredentialAtAdmission } from "../codex-credential-admission";

const accountStatus = jest.fn();
jest.mock("@cocalc/ai/acp", () => ({
  ...jest.requireActual("@cocalc/ai/acp"),
  getCodexAppServerAccountStatus: (...args: any[]) => accountStatus(...args),
}));
jest.mock("../../settings", () => ({ getLiteServerSettings: () => ({}) }));

const owner = "local-account";
const project = project_id || FALLBACK_PROJECT_UUID;
const content = (id: string) =>
  JSON.stringify({
    tokens: {
      account_id: id,
      access_token: `secret-access-${id}`,
      refresh_token: `secret-refresh-${id}`,
    },
  });

describe("Lite credential APIs", () => {
  let home: string;
  const oldHome = process.env.COCALC_CODEX_HOME;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "lite-credential-api-"));
    process.env.COCALC_CODEX_HOME = home;
    accountStatus.mockReset().mockResolvedValue({ rateLimits: {}, models: [] });
  });
  afterEach(async () => {
    if (oldHome == null) delete process.env.COCALC_CODEX_HOME;
    else process.env.COCALC_CODEX_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  });

  it("lists durable uploads, routes usage by ID, and never returns auth contents", async () => {
    const upload = (id: string) =>
      hubApi.projects.codexUploadAuthFileV2({
        account_id: owner,
        project_id: project,
        create: true,
        filename: "auth.json",
        content: content(id),
      });
    const a = await upload("a");
    const b = await upload("b");
    expect(a.credentialId).not.toBe(b.credentialId);
    expect(a.credentialId).not.toBe("lite-default");
    const rows = await hubApi.system.listExternalCredentials({
      account_id: owner,
      provider: "openai",
      kind: "codex-subscription-auth-json",
      scope: "account",
    });
    expect(rows.map(({ id }) => id).sort()).toEqual(
      [a.credentialId, b.credentialId].sort(),
    );
    await hubApi.system.updateCodexSubscriptionLabel({
      account_id: owner,
      id: b.credentialId,
      label: "Work",
    });
    const usage = await hubApi.system.getCodexUsageStatus({
      account_id: owner,
      project_id: project,
      credential_id: b.credentialId,
    });
    expect(usage.paymentSource).toMatchObject({
      credentialId: b.credentialId,
      source: "subscription",
    });
    expect(accountStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        accountId: owner,
        projectId: project,
        credentialId: b.credentialId,
      }),
    );
    expect(JSON.stringify({ rows, a, b, usage })).not.toMatch(
      /secret-access|secret-refresh|access_token|refresh_token/,
    );
    await hubApi.system.revokeExternalCredential({
      account_id: owner,
      id: b.credentialId,
    });
    accountStatus.mockClear();
    const revoked = await hubApi.system.getCodexUsageStatus({
      account_id: owner,
      project_id: project,
      credential_id: b.credentialId,
    });
    expect(revoked).toMatchObject({
      available: false,
      paymentSource: { source: "none" },
    });
    expect(accountStatus).not.toHaveBeenCalled();
    const payment = await hubApi.system.getCodexPaymentSource({
      account_id: owner,
    });
    expect(payment.credentialId).toBe(a.credentialId);
  });

  it("targeted upload updates only the selected record and refuses implicit V2 replacement", async () => {
    const a = await hubApi.projects.codexUploadAuthFileV2({
      account_id: owner,
      project_id: project,
      create: true,
      content: content("a"),
    });
    const b = await hubApi.projects.codexUploadAuthFileV2({
      account_id: owner,
      project_id: project,
      create: true,
      content: content("b"),
    });
    await expect(
      hubApi.projects.codexUploadAuthFileV2({
        account_id: owner,
        project_id: project,
        credential_id: a.credentialId,
        content: content("a"),
      }),
    ).resolves.toMatchObject({ credentialId: a.credentialId });
    await expect(
      hubApi.projects.codexUploadAuthFileV2({
        account_id: owner,
        project_id: project,
        content: content("a"),
      }),
    ).rejects.toThrow("Choose Add");
    expect(
      (await hubApi.system.listExternalCredentials({ account_id: owner }))
        .map(({ id }) => id)
        .sort(),
    ).toEqual([a.credentialId, b.credentialId].sort());
  });

  it("admits explicit subscription B before and after revoking default A without replacing the default", async () => {
    const a = await hubApi.projects.codexUploadAuthFileV2({
      account_id: owner,
      project_id: project,
      create: true,
      content: content("a"),
    });
    const b = await hubApi.projects.codexUploadAuthFileV2({
      account_id: owner,
      project_id: project,
      create: true,
      content: content("b"),
    });
    for (const revoked of [false, true]) {
      if (revoked)
        await hubApi.system.revokeExternalCredential({
          account_id: owner,
          id: a.credentialId,
        });
      const admitted = await pinCodexCredentialAtAdmission({
        project_id: project,
        account_id: owner,
        prompt: "use Work",
        config: {
          paymentSource: "subscription-credential",
          credentialId: b.credentialId,
        },
      });
      expect(admitted.config).toMatchObject({
        paymentSource: "subscription-credential",
        credentialId: b.credentialId,
      });
      const defaultSource = await hubApi.system.getCodexPaymentSource({
        account_id: owner,
        preference: "subscription",
      });
      expect(defaultSource.credentialId).toBe(
        revoked ? undefined : a.credentialId,
      );
      expect(defaultSource.source).toBe(revoked ? "none" : "subscription");
    }
  });
});
