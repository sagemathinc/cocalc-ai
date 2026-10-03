import {
  applyAgentTurnFunding,
  parseAgentTurnFunding,
} from "./agent-turn-funding";

const credentialId = "11111111-2222-4333-8444-555555555555";

describe("parseAgentTurnFunding", () => {
  test("accepts Codex and Claude Code records", () => {
    expect(parseAgentTurnFunding({ version: 1, kind: "codex" })).toEqual({
      version: 1,
      kind: "codex",
    });
    expect(
      parseAgentTurnFunding({
        version: 1,
        kind: "harness",
        profile_id: "claude-code",
        harness_credential: {
          version: 1,
          provider: "anthropic",
          mode: "account-api-key",
          credentialId,
        },
      }),
    ).toMatchObject({ kind: "harness", profile_id: "claude-code" });
  });

  test.each([
    null,
    { version: 2, kind: "codex" },
    { version: 1, kind: "codex", credential_id: "not-a-uuid" },
    { version: 1, kind: "codex", secret: "sk-..." },
    {
      version: 1,
      kind: "harness",
      profile_id: "other",
      harness_credential: {},
    },
    {
      version: 1,
      kind: "harness",
      profile_id: "claude-code",
      harness_credential: {
        version: 1,
        provider: "anthropic",
        mode: "raw-key",
        key: "x",
      },
    },
  ])("rejects %j", (value) => {
    expect(() => parseAgentTurnFunding(value)).toThrow();
  });
});

describe("applyAgentTurnFunding", () => {
  test("keeps an explicit request choice", () => {
    const request = {
      config: { paymentSource: "subscription", credentialId: "explicit" },
    };
    expect(
      applyAgentTurnFunding(request, {
        version: 1,
        kind: "codex",
        credential_id: credentialId,
      }),
    ).toBe(request);
  });

  test("an unpinned Codex record leaves the request unchanged", () => {
    const request = { config: { paymentSource: "subscription" } };
    expect(applyAgentTurnFunding(request, { version: 1, kind: "codex" })).toBe(
      request,
    );
  });
});
