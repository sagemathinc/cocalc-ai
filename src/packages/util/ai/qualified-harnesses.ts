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
    version: "0.79.0",
    integrity:
      "sha512-/liYDBHElfzgbeijv8EZzvDUUAC8wUi1WSCZ+bw/DIKHQ3t3DLid+LS+6lszuQamHAWijjaZl1i5xZVRTnNPoA==",
    gitHead: "d421f56a6c43cde16d9a7531d08a750a5ef2f04a",
    node: ">=22",
  },
  launch: {
    binary: "claude-agent-acp",
    executable:
      "/home/user/.local/share/cocalc/acp/claude-code/0.79.0/node_modules/.bin/claude-agent-acp",
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
