/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// How an account pays for an agent's turns. One account's own choice, stored
// in that account's home bay and shared by all of its devices; never kept in
// browser storage. Values are credential references (ids), never secrets: the
// project host revalidates ownership whenever it admits a turn.

import { isValidUUID } from "../misc";
import type { AcpHarnessCredential } from "./runtime";

export type AgentPaymentProvider = "codex" | "claude-code";

export type CodexPaymentSelection =
  /** Follow the account's designated default ChatGPT subscription. */
  | { version: 1; provider: "codex"; mode: "default" }
  | {
      version: 1;
      provider: "codex";
      mode: "credential";
      credential_id: string;
    };

export type ClaudePaymentSelection =
  /** Follow the account's default for Claude Code agents. */
  | { version: 1; provider: "claude-code"; mode: "default" }
  | { version: 1; provider: "claude-code"; mode: "project-secret" }
  | {
      version: 1;
      provider: "claude-code";
      mode: "account-api-key";
      credential_id: string;
    }
  | {
      version: 1;
      provider: "claude-code";
      mode: "account-subscription";
      credential_id: string;
      /** Only stored when turned off; omitted means connectors are enabled. */
      claude_ai_connectors?: false;
    };

export type AgentPaymentSelection =
  | CodexPaymentSelection
  | ClaudePaymentSelection;

/** One agent conversation. Thread ids are unique within a project; the chat
 * path is kept only so listings can open the agent. */
export interface AgentPaymentTarget {
  project_id: string;
  thread_id: string;
  path?: string;
}

export interface AgentPaymentSelectionRecord {
  project_id: string;
  thread_id: string;
  path?: string;
  provider: AgentPaymentProvider;
  selection: AgentPaymentSelection;
  /** Agent name at the last change, for listings. */
  title?: string;
  updated_at: string;
  last_used_at?: string;
}

export interface AgentPaymentDefaults {
  codex?: CodexPaymentSelection;
  "claude-code"?: ClaudePaymentSelection;
}

export const MAX_AGENT_PAYMENT_SELECTIONS = 10_000;
export const MAX_AGENT_PAYMENT_BULK = 1_000;

export function isAgentPaymentProvider(
  value: unknown,
): value is AgentPaymentProvider {
  return value === "codex" || value === "claude-code";
}

export function validateAgentPaymentTarget(value: unknown): AgentPaymentTarget {
  const obj = (value ?? {}) as Record<string, unknown>;
  if (typeof obj.project_id !== "string" || !isValidUUID(obj.project_id))
    throw Error("invalid agent payment project_id");
  if (
    obj.path !== undefined &&
    (typeof obj.path !== "string" ||
      !obj.path.trim() ||
      obj.path.length > 4096 ||
      obj.path.includes("\0"))
  )
    throw Error("invalid agent payment path");
  if (
    typeof obj.thread_id !== "string" ||
    !obj.thread_id ||
    obj.thread_id.length > 200
  )
    throw Error("invalid agent payment thread_id");
  return {
    project_id: obj.project_id,
    thread_id: obj.thread_id,
    ...(obj.path !== undefined ? { path: obj.path as string } : {}),
  };
}

export function agentPaymentTargetKey(target: {
  project_id: string;
  thread_id: string;
}): string {
  return `thread:${target.project_id}:${target.thread_id}`;
}

export function agentPaymentDefaultKey(provider: AgentPaymentProvider): string {
  return `default:${provider}`;
}

function only(obj: Record<string, unknown>, keys: string[]) {
  if (Object.keys(obj).some((key) => !keys.includes(key)))
    throw Error("unsupported agent payment selection field");
}

function credential(obj: Record<string, unknown>): string {
  if (typeof obj.credential_id !== "string" || !isValidUUID(obj.credential_id))
    throw Error("invalid agent payment credential reference");
  return obj.credential_id;
}

/** Strict parser: rejects anything that is not a credential reference. */
export function parseAgentPaymentSelection(
  value: unknown,
): AgentPaymentSelection {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("invalid agent payment selection");
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1)
    throw Error("unsupported agent payment selection version");
  const base = ["version", "provider", "mode"];
  if (obj.provider === "codex") {
    if (obj.mode === "default") {
      only(obj, base);
      return { version: 1, provider: "codex", mode: "default" };
    }
    if (obj.mode === "credential") {
      only(obj, [...base, "credential_id"]);
      return {
        version: 1,
        provider: "codex",
        mode: "credential",
        credential_id: credential(obj),
      };
    }
  } else if (obj.provider === "claude-code") {
    if (obj.mode === "default" || obj.mode === "project-secret") {
      only(obj, base);
      return { version: 1, provider: "claude-code", mode: obj.mode };
    }
    if (obj.mode === "account-api-key") {
      only(obj, [...base, "credential_id"]);
      return {
        version: 1,
        provider: "claude-code",
        mode: "account-api-key",
        credential_id: credential(obj),
      };
    }
    if (obj.mode === "account-subscription") {
      only(obj, [...base, "credential_id", "claude_ai_connectors"]);
      if (
        obj.claude_ai_connectors !== undefined &&
        obj.claude_ai_connectors !== false
      )
        throw Error("invalid claude_ai_connectors");
      return {
        version: 1,
        provider: "claude-code",
        mode: "account-subscription",
        credential_id: credential(obj),
        ...(obj.claude_ai_connectors === false
          ? { claude_ai_connectors: false as const }
          : {}),
      };
    }
  }
  throw Error("unsupported agent payment selection");
}

/** Which provider pays for a thread's runtime; undefined if per-account
 * selection does not apply (project-managed harnesses). */
export function agentPaymentProviderForRuntime(runtime?: {
  profile: { version: number; id: string };
}): AgentPaymentProvider | undefined {
  if (!runtime) return "codex";
  return runtime.profile.version === 2 && runtime.profile.id === "claude-code"
    ? "claude-code"
    : undefined;
}

/** Resolve a Claude Code selection, following "default" once. */
export function harnessCredentialFromSelection(
  selection: ClaudePaymentSelection | undefined,
  fallback?: ClaudePaymentSelection,
): AcpHarnessCredential {
  const effective =
    !selection || selection.mode === "default"
      ? fallback && fallback.mode !== "default"
        ? fallback
        : undefined
      : selection;
  if (!effective || effective.mode === "project-secret")
    return { version: 1, provider: "anthropic", mode: "project-secret" };
  if (effective.mode === "account-api-key")
    return {
      version: 1,
      provider: "anthropic",
      mode: "account-api-key",
      credentialId: effective.credential_id,
    };
  return {
    version: 1,
    provider: "anthropic",
    mode: "account-subscription",
    credentialId: effective.credential_id,
    ...(effective.claude_ai_connectors === false
      ? { claudeAiConnectors: false }
      : {}),
  };
}

export function selectionFromHarnessCredential(
  credential: AcpHarnessCredential | undefined,
): ClaudePaymentSelection {
  if (!credential || credential.provider !== "anthropic")
    return { version: 1, provider: "claude-code", mode: "project-secret" };
  if (credential.mode === "account-api-key")
    return {
      version: 1,
      provider: "claude-code",
      mode: "account-api-key",
      credential_id: credential.credentialId,
    };
  if (credential.mode === "account-subscription")
    return {
      version: 1,
      provider: "claude-code",
      mode: "account-subscription",
      credential_id: credential.credentialId,
      ...(credential.claudeAiConnectors === false
        ? { claude_ai_connectors: false as const }
        : {}),
    };
  return { version: 1, provider: "claude-code", mode: "project-secret" };
}

/** The pinned ChatGPT subscription, or undefined to use the account default. */
export function codexCredentialFromSelection(
  selection: CodexPaymentSelection | undefined,
): string | undefined {
  return selection?.mode === "credential" ? selection.credential_id : undefined;
}

/** Credential referenced by a selection, for "move all agents on A to B". */
export function selectionCredentialId(
  selection: AgentPaymentSelection,
): string | undefined {
  return "credential_id" in selection ? selection.credential_id : undefined;
}
