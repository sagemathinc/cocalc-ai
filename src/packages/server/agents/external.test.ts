import { randomUUID } from "node:crypto";
import {
  approveExternalAgentLogin,
  externalControl,
  externalEnrollmentStatus,
} from "./external";
import { createAgentRpcControlClient } from "@cocalc/conat/inter-bay/agent-rpc";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import { claimExternalAgentLoginChallenge } from "@cocalc/server/auth/cli-auth";

const mockEnroll = jest.fn(),
  mockStatus = jest.fn(),
  mockRevoke = jest.fn(),
  mockUpdateNetwork = jest.fn(),
  mockRemote = jest.fn();
jest.mock("./external-store", () => ({
  ExternalAgentStore: jest.fn().mockImplementation(() => ({
    enroll: (...args) => mockEnroll(...args),
    enrollmentStatus: (...args) => mockStatus(...args),
    revoke: (...args) => mockRevoke(...args),
  })),
}));
jest.mock("./store", () => ({ agentStore: jest.fn() }));
jest.mock("./api", () => ({ getIdentity: jest.fn() }));
jest.mock("./personal", () => ({
  personalAgentLimits: async () => ({ named: 5, members: 3 }),
  personalStore: () => ({
    updateNetwork: (...args) => mockUpdateNetwork(...args),
  }),
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: jest.fn(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "home",
}));
jest.mock("@cocalc/server/bay-public-origin", () => ({
  getBayPublicOrigin: async () => "https://home.test",
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => "fabric",
}));
jest.mock("@cocalc/server/conat/api/dangerous-session-auth", () => ({
  requireDangerousSessionAuth: jest.fn(),
}));
jest.mock("@cocalc/server/auth/cli-auth", () => ({
  claimExternalAgentLoginChallenge: jest.fn(),
}));
jest.mock("@cocalc/conat/inter-bay/agent-rpc", () => ({
  createAgentRpcControlClient: jest.fn(() => ({
    external: (...args) => mockRemote(...args),
  })),
}));

const account_id = randomUUID(),
  challenge_id = randomUUID(),
  agent_network_id = randomUUID(),
  external_agent_id = randomUUID();
const challenge = {
  label: "External QA",
  secret_hash: "a".repeat(64),
  expires_at: new Date(Date.now() + 900_000).toISOString(),
};
const opts = {
  account_id,
  challenge_id,
  session_hash: "human-home-session",
  origin_bay_id: "origin",
  agent_network_id,
  ttl_seconds: 3600,
};
beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(resolveAccountHomeBay)
    .mockResolvedValue({ home_bay_id: "home" } as any);
  jest.mocked(requireDangerousSessionAuth).mockResolvedValue(undefined as any);
  mockRemote.mockResolvedValue({ challenge });
  mockEnroll.mockResolvedValue({
    installation_id: challenge_id,
    agent_id: external_agent_id,
  });
  mockUpdateNetwork.mockResolvedValue(undefined);
});

test("human approves at home; only a short attestation, never their credential, reaches origin", async () => {
  expect(await approveExternalAgentLogin(opts)).toEqual({
    installation: {
      installation_id: challenge_id,
      agent_id: external_agent_id,
    },
  });
  expect(requireDangerousSessionAuth).toHaveBeenCalledWith({
    account_id,
    session_hash: opts.session_hash,
    require_second_factor: "if_enabled",
    allow_actor_impersonation: false,
  });
  expect(createAgentRpcControlClient).toHaveBeenCalledWith("fabric", "origin");
  expect(mockRemote).toHaveBeenCalledWith({
    action: "claim-enrollment",
    account_id,
    home_bay_id: "home",
    challenge_id,
    fresh_auth_at: expect.any(Number),
  });
  expect(JSON.stringify(mockRemote.mock.calls)).not.toContain(
    opts.session_hash,
  );
  expect(mockEnroll).toHaveBeenCalledWith(
    account_id,
    opts.session_hash,
    {
      installation_id: challenge_id,
      secret_hash: challenge.secret_hash,
      label: challenge.label,
      agent_network_id,
      ttl_seconds: 3600,
    },
    Date.parse(challenge.expires_at),
  );
  expect(mockUpdateNetwork).toHaveBeenCalledWith(
    account_id,
    {
      request_id: challenge_id,
      agent_network_id,
      action: "add-member",
      member: {
        kind: "external",
        agent_id: external_agent_id,
        installation_id: challenge_id,
      },
    },
    3,
    true,
  );
});

test("failed Agent Network membership revokes the enrolled external credential", async () => {
  mockUpdateNetwork.mockRejectedValueOnce(new Error("network unavailable"));

  await expect(approveExternalAgentLogin(opts)).rejects.toThrow(
    "network unavailable",
  );
  expect(mockRevoke).toHaveBeenCalledWith(account_id, challenge_id);
});

test("failed fresh auth or wrong home cannot claim or enroll", async () => {
  jest
    .mocked(requireDangerousSessionAuth)
    .mockRejectedValueOnce(new Error("fresh_auth_required"));
  await expect(approveExternalAgentLogin(opts)).rejects.toThrow(
    "fresh_auth_required",
  );
  expect(mockRemote).not.toHaveBeenCalled();
  jest
    .mocked(resolveAccountHomeBay)
    .mockResolvedValueOnce({ home_bay_id: "different" } as any);
  await expect(approveExternalAgentLogin(opts)).rejects.toThrow("account home");
  expect(mockEnroll).not.toHaveBeenCalled();
});

test("sealed origin claim validates freshness and current home ownership", async () => {
  const request = {
    action: "claim-enrollment" as const,
    account_id,
    home_bay_id: "home",
    challenge_id,
    fresh_auth_at: Date.now(),
  };
  for (const patch of [
    { fresh_auth_at: Date.now() - 31_000 },
    { fresh_auth_at: Infinity },
    { home_bay_id: "stale" },
  ])
    await expect(externalControl({ ...request, ...patch })).rejects.toThrow();
  expect(claimExternalAgentLoginChallenge).not.toHaveBeenCalled();
  jest
    .mocked(claimExternalAgentLoginChallenge)
    .mockResolvedValueOnce(challenge);
  expect(await externalControl(request)).toEqual({ challenge });
});

test("status routes to the home and does not enroll or start work", async () => {
  mockStatus.mockResolvedValueOnce(null);
  expect(
    await externalEnrollmentStatus(
      account_id,
      challenge_id,
      challenge.secret_hash,
    ),
  ).toEqual({ installation: null, api_url: "https://home.test" });
  expect(mockEnroll).not.toHaveBeenCalled();
  expect(requireDangerousSessionAuth).not.toHaveBeenCalled();
  expect(mockStatus).toHaveBeenCalledWith(
    account_id,
    challenge_id,
    challenge.secret_hash,
  );
});

test("external login cannot enroll after challenge expiry", async () => {
  mockRemote.mockResolvedValueOnce({
    challenge: { ...challenge, expires_at: "2000-01-01" },
  });
  await expect(approveExternalAgentLogin(opts)).rejects.toThrow("expired");
  expect(mockEnroll).not.toHaveBeenCalled();
});
