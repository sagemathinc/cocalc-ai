jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: { conat_client: { hub: { agent: {} } } },
}));

import {
  nextTurnFundingForSend,
  recordNextTurnFunding,
} from "../next-turn-funding";

const credentialId = "11111111-2222-4333-8444-555555555555";
const claude = {
  version: 1,
  kind: "acp",
  profile: {
    version: 2,
    kind: "acp",
    id: "claude-code",
    revision: "0.81.1",
    cwd: "/home/user",
    executionPolicy: "full-access",
    credentialMode: "project-managed",
  },
} as const;

test("Claude Code records the selected credential, or the project secret by default", () => {
  const harnessCredential = {
    version: 1,
    provider: "anthropic",
    mode: "account-api-key",
    credentialId,
  } as const;
  expect(
    nextTurnFundingForSend({ runtime: claude as any, harnessCredential }),
  ).toEqual({
    version: 1,
    kind: "harness",
    profile_id: "claude-code",
    harness_credential: harnessCredential,
  });
  expect(
    nextTurnFundingForSend({ runtime: claude as any })?.["harness_credential"],
  ).toEqual({ version: 1, provider: "anthropic", mode: "project-secret" });
});

test("Codex records the subscription pin, and its absence", () => {
  expect(nextTurnFundingForSend({ credentialId })).toEqual({
    version: 1,
    kind: "codex",
    credential_id: credentialId,
  });
  expect(nextTurnFundingForSend({})).toEqual({ version: 1, kind: "codex" });
});

test("project-managed harnesses record nothing", () => {
  expect(
    nextTurnFundingForSend({
      runtime: {
        ...claude,
        profile: { ...claude.profile, id: "other-harness" },
      } as any,
    }),
  ).toBeUndefined();
});

test("recording never throws into the send path and skips non-chat paths", async () => {
  const api = {
    setNextTurnFunding: jest.fn(async () => {
      throw new Error("old hub");
    }),
  };
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const funding = { version: 1, kind: "codex" } as const;
  await recordNextTurnFunding({
    project_id: "p",
    path: "a.chat",
    thread_id: "t",
    funding,
    api,
  });
  await recordNextTurnFunding({
    project_id: "p",
    path: "virtual-path",
    thread_id: "t",
    funding,
    api,
  });
  expect(api.setNextTurnFunding).toHaveBeenCalledTimes(1);
  expect(api.setNextTurnFunding).toHaveBeenCalledWith({
    project_id: "p",
    path: "a.chat",
    thread_id: "t",
    funding,
  });
  warn.mockRestore();
});
