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
    // Earlier pins of this harness. Saved profiles that name one of these are
    // upgraded to the current version: CoCalc installs and runs only one.
    supersededVersions?: readonly string[];
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
    version: "0.84.0",
    integrity:
      "sha512-Zhjyxvm7USDB/BAFx2L6U6rA3spJ6qwEDFbLgByzpmQMeZGuAlZPXhMcAc+Xsndj9kDh+OFJNjETRwGJCR1eTQ==",
    gitHead: "bdb50ad984336e62dde1d41339f04071f6617085",
    node: ">=22",
    supersededVersions: ["0.81.1"],
  },
  launch: {
    binary: "claude-agent-acp",
    executable: "/opt/cocalc/harnesses/claude-code/0.84.0/bin/claude-agent-acp",
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

/**
 * The exact qualified Claude Code harness (version 2 profile at the current
 * pinned revision). Authority reserved for trusted runtimes, such as the
 * managed CoCalc connector, must require this, never an arbitrary ACP profile.
 */
export function isQualifiedClaudeCodeProfile(
  profile: { version?: unknown; id?: unknown; revision?: unknown } | undefined,
): boolean {
  return (
    profile?.version === 2 &&
    profile.id === CLAUDE_CODE_QUALIFICATION.id &&
    profile.revision === CLAUDE_CODE_QUALIFICATION.package.version &&
    CLAUDE_CODE_QUALIFICATION.status !== "disabled"
  );
}
