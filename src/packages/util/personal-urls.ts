/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { checkAccountName } from "./db-schema/name-rules";

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const KINDS = new Set(["agents", "artifacts", "chats", "people"]);

export type PersonalUrlKind = "agents" | "artifacts" | "chats" | "people";

export interface PersonalUrlOwner {
  account_id: string;
  username: string | null;
  redirect: boolean;
}

export type PersonalUrlTarget =
  | {
      kind: "agent";
      project_id: string;
      agent_id: string;
      chat_path?: string;
      thread_id?: string;
    }
  | {
      kind: "artifact";
      project_id: string;
      entry_id: string;
      chat_path?: string;
      thread_id?: string;
      artifact_id?: string;
    }
  | {
      kind: "conversation";
      project_id: string;
      conversation_id: string;
      chat_path?: string;
    }
  | { kind: "person"; person_id: string };

export interface ResolvedPersonalUrl {
  owner: PersonalUrlOwner;
  kind: PersonalUrlKind;
  alias: string;
  /** Site-relative address with the current username (or permanent account ID). */
  canonical_path: string;
  status: "resolved" | "unavailable" | "access-denied" | "inspection";
  /** Only authorized reads or explicit admin inspection include a content locator. */
  target?: PersonalUrlTarget;
  /** A denied link may offer the existing project-access request flow. */
  project_id?: string;
}

export function normalizePersonalUrlOwner(owner: string): string {
  if (typeof owner !== "string") throw Error("Invalid URL owner");
  const value = owner.trim().toLowerCase();
  if (UUID.test(value)) return value;
  checkAccountName(value);
  return value;
}

export function personalUrlPath(
  owner: string,
  kind: PersonalUrlKind,
  alias?: string,
): string {
  if (!KINDS.has(kind)) throw Error("Invalid personal URL kind");
  const prefix = `/u/${encodeURIComponent(normalizePersonalUrlOwner(owner))}/${kind}`;
  if (alias == null) return prefix;
  if (!alias || alias.length > 200 || /[\s/\\?#\u0000-\u001f]/.test(alias))
    throw Error("Invalid personal alias");
  return `${prefix}/${encodeURIComponent(alias)}`;
}

/** Parse without fetching or trusting the URL's host as an API endpoint. */
export function parsePersonalUrl(value: string): {
  owner: string;
  kind: PersonalUrlKind;
  alias?: string;
} {
  if (typeof value !== "string" || value.length > 4096)
    throw Error("Invalid personal URL");
  let path = value;
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.username || url.password) throw Error("Invalid personal URL");
    path = url.pathname;
  } else {
    if (value.startsWith("//") || value.includes("://"))
      throw Error("Invalid personal URL");
    path = value.split(/[?#]/)[0];
  }
  const parts = path.replace(/^\//, "").replace(/\/$/, "").split("/");
  if (parts[0] !== "u" || (parts.length !== 3 && parts.length !== 4))
    throw Error("Expected /u/{username-or-account-id}/{kind}/{alias}");
  const owner = normalizePersonalUrlOwner(decodeURIComponent(parts[1]));
  if (!KINDS.has(parts[2])) throw Error("Invalid personal URL kind");
  const kind = parts[2] as PersonalUrlKind;
  const alias = parts[3] == null ? undefined : decodeURIComponent(parts[3]);
  personalUrlPath(owner, kind, alias);
  return { owner, kind, alias };
}
