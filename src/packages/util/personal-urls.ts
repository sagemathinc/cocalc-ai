/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { checkAccountName } from "./db-schema/name-rules";
import { trimTrailingSlashes } from "./linear-text";

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const KINDS = new Set(["agents", "artifacts", "chats", "people", "projects"]);

export type PersonalUrlKind =
  | "agents"
  | "artifacts"
  | "chats"
  | "people"
  | "projects";

// Personal aliases are public names, not secrets: anyone who knows the
// owner's username (or account id) and an alias can learn what it points to,
// including its project id. Opening the target still requires access to that
// project. People aliases are the exception: they are private nicknames and
// resolve only for their owner.

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
  | { kind: "person"; person_id: string }
  | { kind: "project"; project_id: string };

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
  /** Projects: the path inside the project after the alias, e.g. files/a.md. */
  rest?: string;
  /** Projects: what `rest` opens, decoded (see projectLocation). */
  location?: ProjectLocation;
}

/**
 * What a project URL's path opens. `files/home/user/a.md` is the file
 * /home/user/a.md (paths after files/ are absolute in the project, without
 * the leading slash); a trailing slash is a directory. Anything else names a
 * project page, e.g. `settings` or `log`.
 */
export type ProjectLocation =
  | { kind: "file" | "directory"; path: string }
  | { kind: "page"; page: string; path?: string };

export function projectLocation(rest?: string): ProjectLocation | undefined {
  if (!rest) return undefined;
  const [head, ...tail] = rest.split("/");
  const decoded = tail.map(decodeURIComponent).join("/");
  if (head === "files") {
    if (!decoded) return { kind: "directory", path: "/" };
    return decoded.endsWith("/")
      ? { kind: "directory", path: `/${trimTrailingSlashes(decoded)}` }
      : { kind: "file", path: `/${decoded}` };
  }
  return decoded
    ? { kind: "page", page: head, path: `/${trimTrailingSlashes(decoded)}` }
    : { kind: "page", page: head };
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
  /** Projects only: the rest of the path inside the project. */
  rest?: string;
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
  const extra = parts[2] === "projects" && parts.length > 4;
  if (parts[0] !== "u" || (parts.length !== 3 && parts.length !== 4 && !extra))
    throw Error("Expected /u/{username-or-account-id}/{kind}/{alias}");
  const owner = normalizePersonalUrlOwner(decodeURIComponent(parts[1]));
  if (!KINDS.has(parts[2])) throw Error("Invalid personal URL kind");
  const kind = parts[2] as PersonalUrlKind;
  const alias = parts[3] == null ? undefined : decodeURIComponent(parts[3]);
  personalUrlPath(owner, kind, alias);
  if (!extra) return { owner, kind, alias };
  // Kept encoded, as in the app's own project paths; a trailing slash
  // (a folder listing) is significant.
  const segments = parts.slice(4);
  if (
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        /[\u0000-\u001f]/.test(decodeURIComponent(segment)),
    )
  )
    throw Error("Invalid path in personal URL");
  const rest = segments.join("/") + (path.endsWith("/") ? "/" : "");
  return { owner, kind, alias, rest };
}
