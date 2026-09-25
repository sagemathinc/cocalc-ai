/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  newAgentClaudeCredentialOptions,
  newAgentClaudeCredentialDefault,
  newAgentClaudeCredentialValue,
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
    { value: "project-secret", label: "Project secret" },
    {
      value: "account-subscription:subscription-1",
      label: "Claude pro - subscriber@example.com",
    },
    { value: "account-api-key:key-1", label: "Backup key" },
  ]);
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
  expect(
    newAgentClaudeCredentialDefault([sub, { ...sub, id: "other" }]).mode,
  ).toBe("project-secret");
  expect(
    newAgentClaudeCredentialDefault([{ ...sub, kind: "anthropic-api-key" }])
      .mode,
  ).toBe("project-secret");
});
