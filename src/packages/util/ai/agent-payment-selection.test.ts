/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
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
