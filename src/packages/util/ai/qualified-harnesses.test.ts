/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  CLAUDE_CODE_QUALIFICATION,
  QUALIFIED_HARNESS_CANDIDATES,
} from "./qualified-harnesses";

test("Claude qualification is pinned and fails closed on subscriptions", () => {
  expect(CLAUDE_CODE_QUALIFICATION).toMatchObject({
    status: "qualification",
    protocolVersion: 1,
    package: {
      name: "@agentclientprotocol/claude-agent-acp",
      version: "0.79.0",
      integrity: expect.stringMatching(/^sha512-/),
      gitHead: expect.stringMatching(/^[a-f0-9]{40}$/),
    },
    launch: {
      binary: "claude-agent-acp",
      requiredArgs: expect.arrayContaining(["--hide-claude-auth"]),
    },
    authentication: {
      allowed: ["anthropic-api-key"],
      blocked: ["claude-pro-max-subscription"],
    },
  });
  expect(CLAUDE_CODE_QUALIFICATION.releaseGates).toContain(
    "credential-tool-isolation",
  );
});

test("candidate IDs and package coordinates are unique", () => {
  expect(new Set(QUALIFIED_HARNESS_CANDIDATES.map(({ id }) => id)).size).toBe(
    QUALIFIED_HARNESS_CANDIDATES.length,
  );
  expect(
    new Set(
      QUALIFIED_HARNESS_CANDIDATES.map(
        ({ package: pkg }) => `${pkg.name}@${pkg.version}`,
      ),
    ).size,
  ).toBe(QUALIFIED_HARNESS_CANDIDATES.length);
});
