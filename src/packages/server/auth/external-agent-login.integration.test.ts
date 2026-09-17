import { createHash, randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import {
  startExternalAgentLoginChallenge,
  claimExternalAgentLoginChallenge,
  getCliAuthChallengeStatus,
  approveCliLoginChallenge,
  redeemCliLoginChallenge,
} from "./cli-auth";

const mockEnrollmentStatus = jest.fn();
jest.mock("@cocalc/server/agents/external", () => ({
  assertExternalAgentLoginEnabled: jest.fn(),
  externalEnrollmentStatus: (...args) => mockEnrollmentStatus(...args),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "origin",
}));
jest.mock("@cocalc/server/bay-public-origin", () => ({
  getBayPublicOriginForRequest: async () => "https://origin.test",
}));
jest.mock("@cocalc/backend/base-path", () => "/");

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
describeDb(
  "external CLI challenges reuse bounded auth state without human sessions",
  () => {
    const account = randomUUID(),
      other = randomUUID();
    const secret_hash = "a".repeat(64);
    const start = () =>
      startExternalAgentLoginChallenge({
        req: { ip: "127.0.0.1" },
        label: "Security agent",
        secret_hash,
      });
    beforeAll(async () => {
      await syncSchema({
        account_cli_auth_challenges: SCHEMA.account_cli_auth_challenges,
      });
    });
    beforeEach(async () => {
      await getPool().query("DELETE FROM account_cli_auth_challenges");
      mockEnrollmentStatus
        .mockReset()
        .mockResolvedValue({
          installation: null,
          api_url: "https://home.test",
        });
    });

    test("start is unbound to an account and stores only poll and credential hashes", async () => {
      const request = await start();
      const row = (
        await getPool().query("SELECT * FROM account_cli_auth_challenges")
      ).rows[0];
      expect(row.kind).toBe("external-agent");
      expect(row.account_id).toBe("00000000-0000-0000-0000-000000000000");
      expect(row.poll_token_hash).toBe(
        createHash("sha256").update(request.poll_token).digest("hex"),
      );
      expect(row.metadata).toMatchObject({
        secret_hash,
        label: "Security agent",
      });
      expect(JSON.stringify(row)).not.toContain(request.poll_token);
      expect(
        new Date(request.expires_at).getTime() - Date.now(),
      ).toBeLessThanOrEqual(900_000);
      expect(request.approval_url).toBe(
        `https://origin.test/auth/cli-login/${request.challenge_id}`,
      );
      expect(await getCliAuthChallengeStatus(request)).toMatchObject({
        kind: "external-agent",
        state: "pending",
        external: { installation: null },
      });
      expect(mockEnrollmentStatus).not.toHaveBeenCalled();
    });

    test("concurrent human claims bind exactly one account; repeating its claim is harmless", async () => {
      const request = await start();
      const results = await Promise.allSettled([
        claimExternalAgentLoginChallenge(request.challenge_id, account),
        claimExternalAgentLoginChallenge(request.challenge_id, other),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const row = (
        await getPool().query("SELECT * FROM account_cli_auth_challenges")
      ).rows[0];
      expect(
        await claimExternalAgentLoginChallenge(
          request.challenge_id,
          row.account_id,
        ),
      ).toMatchObject({ label: "Security agent", secret_hash });
      expect(row.status).toBe("pending");
      expect(row.redeem_token_hash).toBeNull();
    });

    test("invalid poll secret, expired challenge and normal session redemption all fail closed", async () => {
      const request = await start();
      await claimExternalAgentLoginChallenge(request.challenge_id, account);
      await expect(
        getCliAuthChallengeStatus({ ...request, poll_token: "wrong" }),
      ).rejects.toThrow("invalid cli auth poll token");
      expect(mockEnrollmentStatus).not.toHaveBeenCalled();
      await expect(
        approveCliLoginChallenge({
          challenge_id: request.challenge_id,
          account_id: account,
        }),
      ).rejects.toThrow("unknown cli auth challenge");
      await expect(
        redeemCliLoginChallenge({
          challenge_id: request.challenge_id,
          redeem_token: request.poll_token,
        }),
      ).rejects.toThrow("unknown cli auth challenge");
      await getPool().query(
        "UPDATE account_cli_auth_challenges SET expire=now()-interval '1 second'",
      );
      await expect(
        claimExternalAgentLoginChallenge(request.challenge_id, account),
      ).rejects.toThrow("expired");
      await expect(getCliAuthChallengeStatus(request)).rejects.toThrow(
        "expired",
      );
    });

    test("claim does not imply approval; status observes authoritative home installation", async () => {
      const request = await start();
      await claimExternalAgentLoginChallenge(request.challenge_id, account);
      expect(await getCliAuthChallengeStatus(request)).toMatchObject({
        state: "pending",
      });
      const installation = {
        installation_id: request.challenge_id,
        account_id: account,
        agent_id: randomUUID(),
        state: "active",
      };
      mockEnrollmentStatus.mockResolvedValueOnce({
        installation,
        api_url: "https://home.test",
      });
      const status = await getCliAuthChallengeStatus(request);
      expect(status).toMatchObject({
        state: "approved",
        kind: "external-agent",
        external: { installation },
      });
      expect(status).not.toHaveProperty("redeem_token");
      expect(status).not.toHaveProperty("remember_me");
      expect(mockEnrollmentStatus).toHaveBeenLastCalledWith(
        account,
        request.challenge_id,
        secret_hash,
      );
    });

    test("external starts share the existing IP login rate limit", async () => {
      for (let i = 0; i < 20; i++) await start();
      await expect(start()).rejects.toThrow("too many cli login attempts");
      expect(
        (await getPool().query("SELECT * FROM account_cli_auth_challenges"))
          .rows,
      ).toHaveLength(20);
    });
  },
);
