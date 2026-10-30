/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  claudePoolSelection,
  harnessCredentialFromSelection,
  parseAgentPaymentSelection,
  selectionFromHarnessCredential,
} from "./agent-payment-selection";
import { parseAcpHarnessCredential } from "./runtime";

const claude = {
  version: 2,
  kind: "acp",
  id: "claude-code",
  revision: "0.93.0",
  cwd: "/tmp",
  credentialMode: "project-managed",
  executionPolicy: "full-access",
} as any;

describe("site-funded Claude payment selection", () => {
  const membership = {
    version: 1,
    provider: "claude-code",
    mode: "membership",
  } as const;

  it("parses the membership selection, and nothing extra with it", () => {
    expect(parseAgentPaymentSelection(membership)).toEqual(membership);
    expect(() =>
      parseAgentPaymentSelection({ ...membership, credential_id: "x" }),
    ).toThrow("unsupported agent payment selection field");
  });

  it("maps membership to the site-funded harness credential and back", () => {
    const credential = harnessCredentialFromSelection(membership);
    expect(credential).toEqual({
      version: 1,
      provider: "anthropic",
      mode: "site-funded",
    });
    expect(selectionFromHarnessCredential(credential)).toEqual(membership);
    // As the default a selection follows.
    expect(
      harnessCredentialFromSelection(
        { version: 1, provider: "claude-code", mode: "default" },
        membership,
      ),
    ).toEqual(credential);
  });

  it("accepts a site-funded harness credential with no credential reference", () => {
    expect(
      parseAcpHarnessCredential(
        { version: 1, provider: "anthropic", mode: "site-funded" },
        claude,
      ),
    ).toEqual({ version: 1, provider: "anthropic", mode: "site-funded" });
    expect(() =>
      parseAcpHarnessCredential(
        {
          version: 1,
          provider: "anthropic",
          mode: "site-funded",
          credentialId: "11111111-1111-4111-8111-111111111111",
        },
        claude,
      ),
    ).toThrow("Unsupported ACP harness credential field");
  });
});

describe("Auto (the Claude subscription pool)", () => {
  const pool = {
    version: 1,
    provider: "claude-code",
    mode: "subscription-pool",
  } as const;

  it("parses Auto, with connectors off at most", () => {
    expect(parseAgentPaymentSelection(pool)).toEqual(pool);
    expect(
      parseAgentPaymentSelection({ ...pool, claude_ai_connectors: false }),
    ).toEqual({ ...pool, claude_ai_connectors: false });
    expect(() =>
      parseAgentPaymentSelection({ ...pool, claude_ai_connectors: true }),
    ).toThrow("invalid claude_ai_connectors");
    expect(() =>
      parseAgentPaymentSelection({ ...pool, credential_id: "x" }),
    ).toThrow("unsupported agent payment selection field");
  });

  it("has no credential: the host picks one for each turn", () => {
    expect(harnessCredentialFromSelection(pool)).toBeUndefined();
    expect(claudePoolSelection(pool)).toEqual(pool);
    // As the default an agent follows.
    const follows = {
      version: 1,
      provider: "claude-code",
      mode: "default",
    } as const;
    expect(harnessCredentialFromSelection(follows, pool)).toBeUndefined();
    expect(claudePoolSelection(follows, pool)).toEqual(pool);
    // An agent's own choice wins over an Auto default.
    expect(
      claudePoolSelection(
        { version: 1, provider: "claude-code", mode: "project-secret" },
        pool,
      ),
    ).toBeUndefined();
  });
});
