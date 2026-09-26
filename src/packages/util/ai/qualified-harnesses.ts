/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export type QualifiedHarnessCandidate = {
  id: string;
  title: string;
  status: "qualification" | "enabled" | "disabled";
  protocolVersion: number;
  package: {
    name: string;
    version: string;
    integrity: string;
    gitHead: string;
    node: string;
  };
  launch: {
    binary: string;
    executable: string;
    requiredArgs: readonly string[];
    projectSecret?: {
      name: string;
      environmentVariable: string;
    };
  };
  authentication: {
    allowed: readonly string[];
    blocked: readonly string[];
  };
  releaseGates: readonly string[];
};

/**
 * Pinned qualification input, not yet a user-visible catalog entry.
 *
 * `--hide-claude-auth` is mandatory while account subscription credentials
 * cannot be isolated from Claude's model-controlled built-in shell tools.
 */
export const CLAUDE_CODE_QUALIFICATION: QualifiedHarnessCandidate = {
  id: "claude-code",
  title: "Claude Code",
  status: "qualification",
  protocolVersion: 1,
  package: {
    name: "@agentclientprotocol/claude-agent-acp",
    version: "0.81.1",
    integrity:
      "sha512-I+7tUPsrYnI0nBmdUonoRmdCi7ohyzZ0SeCpeIUFuVZ7a8ZxDyUNO6zBJpaeAIwuPXCk8aw+7t+QiwXS6FwskQ==",
    gitHead: "b264b52bee80e49f20caf1941f7d7cb89edb80c4",
    node: ">=22",
  },
  launch: {
    binary: "claude-agent-acp",
    executable: "/opt/cocalc/harnesses/claude-code/0.81.1/bin/claude-agent-acp",
    requiredArgs: ["--hide-claude-auth"],
    projectSecret: {
      name: "ANTHROPIC_API_KEY",
      environmentVariable: "ANTHROPIC_API_KEY",
    },
  },
  authentication: {
    allowed: ["anthropic-api-key"],
    blocked: ["claude-pro-max-subscription"],
  },
  releaseGates: [
    "managed-install",
    "account-credential-runtime-binding",
    "credential-tool-isolation",
    "claude-live-api-key-qualification",
    "security-review",
  ],
};

export const QUALIFIED_HARNESS_CANDIDATES: readonly QualifiedHarnessCandidate[] =
  [CLAUDE_CODE_QUALIFICATION];

export function getQualifiedHarnessCandidate(
  id: string,
): QualifiedHarnessCandidate | undefined {
  return QUALIFIED_HARNESS_CANDIDATES.find((candidate) => candidate.id === id);
}
