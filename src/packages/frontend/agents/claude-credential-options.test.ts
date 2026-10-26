/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  claudeCredentialFromValue,
  SITE_FUNDED_CLAUDE_VALUE,
  newAgentClaudeCredentialOptions,
  newAgentClaudeCredentialDefault,
  newAgentClaudeCredentialValue,
  preferredClaudeCredential,
} from "./claude-credential-options";

test("new agents list subscriptions and retain the selected billing source", () => {
  const subscription = {
    id: "subscription-1",
    kind: "claude-subscription-home-v1",
    revoked: null,
    metadata: {
      plan: "pro",
      cocalc_provider_identity: "subscriber@example.com",
    },
  };
  expect(
    newAgentClaudeCredentialOptions([
      subscription,
      {
        id: "key-1",
        kind: "anthropic-api-key",
        revoked: null,
        metadata: { label: "Backup key" },
      },
      { ...subscription, id: "revoked", revoked: "2026-09-24" },
    ] as any),
  ).toEqual([
    {
      value: "account-subscription:subscription-1",
      label: "Claude Pro - subscriber@example.com",
    },
    { value: "account-api-key:key-1", label: "Backup key" },
    { value: "project-secret", label: "Project secret (ANTHROPIC_API_KEY)" },
  ]);
  expect(
    newAgentClaudeCredentialOptions([subscription] as any, true)[0].label,
  ).toBe("Claude Pro - subscriber");
  expect(
    newAgentClaudeCredentialValue({
      version: 1,
      provider: "anthropic",
      mode: "account-subscription",
      credentialId: "subscription-1",
    }),
  ).toBe("account-subscription:subscription-1");
});

test("new agents reuse a unique connected subscription, not a revoked or ambiguous one", () => {
  const sub = {
    id: "sub",
    kind: "claude-subscription-home-v1",
    revoked: null,
  } as any;
  expect(newAgentClaudeCredentialDefault([sub])).toMatchObject({
    mode: "account-subscription",
    credentialId: "sub",
  });
  expect(
    newAgentClaudeCredentialDefault([{ ...sub, revoked: "today" }]).mode,
  ).toBe("project-secret");
  // With several subscriptions, the most recently used one.
  expect(
    newAgentClaudeCredentialDefault([
      { ...sub, last_used: "2026-09-01T00:00:00Z" },
      { ...sub, id: "recent", last_used: "2026-10-01T00:00:00Z" },
    ]),
  ).toMatchObject({ mode: "account-subscription", credentialId: "recent" });
  // An account API key before the project secret.
  expect(
    newAgentClaudeCredentialDefault([{ ...sub, kind: "anthropic-api-key" }]),
  ).toMatchObject({ mode: "account-api-key", credentialId: "sub" });
});

test("a remembered credential is kept while it exists, never a project secret over a subscription", () => {
  const sub = {
    id: "new-sub",
    kind: "claude-subscription-home-v1",
    revoked: null,
  } as any;
  const key = { id: "key", kind: "anthropic-api-key", revoked: null } as any;
  const remembered = (credentialId: string, mode: any) =>
    ({ version: 1, provider: "anthropic", mode, credentialId }) as any;
  expect(
    preferredClaudeCredential(remembered("key", "account-api-key"), [sub, key]),
  ).toMatchObject({ mode: "account-api-key", credentialId: "key" });
  // The remembered subscription was disconnected: use the current one.
  expect(
    preferredClaudeCredential(
      {
        ...remembered("old-sub", "account-subscription"),
        claudeAiConnectors: false,
      },
      [sub, { ...sub, id: "old-sub", revoked: "today" }],
    ),
  ).toEqual({
    version: 1,
    provider: "anthropic",
    mode: "account-subscription",
    credentialId: "new-sub",
    claudeAiConnectors: false,
  });
  expect(
    preferredClaudeCredential(
      { version: 1, provider: "anthropic", mode: "project-secret" },
      [sub],
    ),
  ).toMatchObject({ mode: "account-subscription", credentialId: "new-sub" });
});

test("a long-lived token subscription is named by its label, else generically", () => {
  const token = {
    id: "token-1",
    kind: "claude-subscription-home-v1",
    revoked: null,
    metadata: { authentication: "claude-oauth-token" },
  };
  expect(newAgentClaudeCredentialOptions([token] as any)[0].label).toBe(
    "Claude subscription",
  );
  expect(
    newAgentClaudeCredentialOptions([
      { ...token, metadata: { ...token.metadata, label: "Max 20x" } },
    ] as any)[0].label,
  ).toBe("Max 20x");
});

describe("included Claude (CoCalc Membership)", () => {
  const key = {
    id: "key-1",
    kind: "anthropic-api-key",
    revoked: null,
    metadata: {},
  } as any;
  const siteFunded = {
    version: 1,
    provider: "anthropic",
    mode: "site-funded",
  } as const;
  const projectSecret = {
    version: 1,
    provider: "anthropic",
    mode: "project-secret",
  } as const;

  test("is offered after the account's own credentials, before the project secret", () => {
    expect(
      newAgentClaudeCredentialOptions([key], false, true).map(
        ({ value }) => value,
      ),
    ).toEqual([
      "account-api-key:key-1",
      SITE_FUNDED_CLAUDE_VALUE,
      "project-secret",
    ]);
    expect(newAgentClaudeCredentialOptions([], true, true)[0].label).toBe(
      "CoCalc Membership",
    );
    expect(
      newAgentClaudeCredentialOptions([], false, false).map(
        ({ value }) => value,
      ),
    ).toEqual(["project-secret"]);
  });

  test("round-trips through the picker value", () => {
    expect(newAgentClaudeCredentialValue(siteFunded)).toBe(
      SITE_FUNDED_CLAUDE_VALUE,
    );
    expect(claudeCredentialFromValue(SITE_FUNDED_CLAUDE_VALUE)).toEqual(
      siteFunded,
    );
    expect(claudeCredentialFromValue("account-api-key:key-1")).toEqual({
      version: 1,
      provider: "anthropic",
      mode: "account-api-key",
      credentialId: "key-1",
    });
    expect(claudeCredentialFromValue("project-secret")).toEqual(projectSecret);
  });

  test("is the default only without a Claude credential, and never replaces a chosen project secret", () => {
    expect(newAgentClaudeCredentialDefault([], true)).toEqual(siteFunded);
    expect(newAgentClaudeCredentialDefault([], false)).toEqual(projectSecret);
    expect(newAgentClaudeCredentialDefault([key], true)).toMatchObject({
      mode: "account-api-key",
    });
    expect(preferredClaudeCredential(projectSecret, [], true)).toEqual(
      projectSecret,
    );
    // A remembered membership choice is kept while it is offered.
    expect(preferredClaudeCredential(siteFunded, [key], true)).toEqual(
      siteFunded,
    );
    expect(preferredClaudeCredential(siteFunded, [key], false)).toMatchObject({
      mode: "account-api-key",
    });
  });
});
