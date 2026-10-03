/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Server-side record of how an account pays for an agent's next turn, so a
// turn started by an agent message pays exactly like the account's last human
// send to that agent. Only credential references are stored here; the project
// host revalidates ownership when it admits the turn.

import { isValidUUID } from "../misc";
import {
  parseAcpHarnessCredential,
  type AcpHarnessCredential,
  type AcpHarnessProfile,
} from "./runtime";

export type AgentTurnFunding =
  | {
      version: 1;
      kind: "codex";
      /** Account-local ChatGPT subscription pin; absent means the default. */
      credential_id?: string;
    }
  | {
      version: 1;
      kind: "harness";
      profile_id: string;
      harness_credential: AcpHarnessCredential;
    };

const CLAUDE_CODE_PROFILE: AcpHarnessProfile = {
  version: 2,
  kind: "acp",
  id: "claude-code",
  revision: "",
  cwd: "",
  executionPolicy: "full-access",
  credentialMode: "project-managed",
};

export function parseAgentTurnFunding(value: unknown): AgentTurnFunding {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("invalid agent turn funding");
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) throw Error("unsupported agent turn funding version");
  if (obj.kind === "codex") {
    if (
      Object.keys(obj).some(
        (k) => !["version", "kind", "credential_id"].includes(k),
      )
    )
      throw Error("invalid agent turn funding");
    if (obj.credential_id === undefined) return { version: 1, kind: "codex" };
    if (
      typeof obj.credential_id !== "string" ||
      !isValidUUID(obj.credential_id)
    )
      throw Error("invalid agent turn funding credential");
    return { version: 1, kind: "codex", credential_id: obj.credential_id };
  }
  if (obj.kind === "harness") {
    if (
      Object.keys(obj).some(
        (k) =>
          !["version", "kind", "profile_id", "harness_credential"].includes(k),
      )
    )
      throw Error("invalid agent turn funding");
    // Only Claude Code takes account-level credentials today; other harnesses
    // are project-managed and need no record.
    if (obj.profile_id !== "claude-code")
      throw Error("unsupported agent turn funding runtime");
    const harness_credential = parseAcpHarnessCredential(
      obj.harness_credential,
      CLAUDE_CODE_PROFILE,
    );
    return {
      version: 1,
      kind: "harness",
      profile_id: "claude-code",
      harness_credential,
    };
  }
  throw Error("unsupported agent turn funding kind");
}

interface FundableRequest {
  runtime?: { profile: AcpHarnessProfile };
  harness_credential?: AcpHarnessCredential;
  config?: { paymentSource?: string; credentialId?: string };
}

/**
 * Apply a stored funding record to an agent-message turn request, using the
 * same rules as the browser: a Claude Code credential for the same runtime,
 * or a ChatGPT subscription pin when the thread pays by subscription. A
 * mismatched record is ignored, so admission reports the missing choice.
 */
export function applyAgentTurnFunding<T extends FundableRequest>(
  request: T,
  funding: AgentTurnFunding | undefined,
): T {
  if (!funding) return request;
  if (request.runtime) {
    const profile = request.runtime.profile;
    if (
      funding.kind !== "harness" ||
      request.harness_credential ||
      profile.version !== 2 ||
      profile.id !== funding.profile_id
    )
      return request;
    return { ...request, harness_credential: funding.harness_credential } as T;
  }
  if (
    funding.kind !== "codex" ||
    !funding.credential_id ||
    request.config?.credentialId ||
    request.config?.paymentSource !== "subscription"
  )
    return request;
  return {
    ...request,
    config: {
      ...request.config,
      paymentSource: "subscription-credential",
      credentialId: funding.credential_id,
    },
  } as T;
}
