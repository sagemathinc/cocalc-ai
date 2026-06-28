import { inboxPrefix } from "@cocalc/conat/names";
import { isValidUUID } from "@cocalc/util/misc";

export type CoCalcUser =
  | {
      account_id: string;
      project_id?: string;
      hub_id?: string;
      host_id?: string;
      error?: string;
      auth_iat_s?: number;
      auth_session_hash?: string;
    }
  | {
      account_id?: string;
      project_id?: string;
      hub_id: string;
      host_id?: string;
      error?: string;
      auth_iat_s?: number;
      auth_session_hash?: string;
    }
  | {
      account_id?: string;
      project_id: string;
      hub_id?: string;
      host_id?: string;
      error?: string;
      auth_iat_s?: number;
      auth_session_hash?: string;
    }
  | {
      account_id?: string;
      project_id?: string;
      hub_id?: string;
      host_id: string;
      error?: string;
      auth_iat_s?: number;
      auth_session_hash?: string;
    }
  | {
      account_id?: string;
      project_id?: string;
      hub_id?: string;
      host_id?: string;
      error: string;
      auth_iat_s?: number;
      auth_session_hash?: string;
    };

export type CoCalcUserType = "account" | "project" | "hub" | "host";

export function getCoCalcUserType({
  account_id,
  project_id,
  hub_id,
  host_id,
}: CoCalcUser): CoCalcUserType {
  if (account_id) {
    if (project_id || hub_id || host_id) {
      throw Error(
        "exactly one of account_id or project_id or hub_id or host_id must be specified",
      );
    }
    return "account";
  }
  if (project_id) {
    if (hub_id || host_id) {
      throw Error(
        "exactly one of account_id or project_id or hub_id or host_id must be specified",
      );
    }
    return "project";
  }
  if (hub_id) {
    if (host_id) {
      throw Error(
        "exactly one of account_id or project_id or hub_id or host_id must be specified",
      );
    }
    return "hub";
  }
  if (host_id) {
    return "host";
  }
  throw Error(
    "account_id or project_id or hub_id or host_id must be specified in user",
  );
}

export function getCoCalcUserId({
  account_id,
  project_id,
  hub_id,
  host_id,
}: CoCalcUser): string {
  if (account_id) {
    if (project_id || hub_id || host_id) {
      throw Error(
        "exactly one of account_id or project_id or hub_id or host_id must be specified",
      );
    }
    return account_id;
  }
  if (project_id) {
    if (hub_id || host_id) {
      throw Error(
        "exactly one of account_id or project_id or hub_id or host_id must be specified",
      );
    }
    return project_id;
  }
  if (hub_id) {
    if (host_id) {
      throw Error(
        "exactly one of account_id or project_id or hub_id or host_id must be specified",
      );
    }
    return hub_id;
  }
  if (host_id) {
    return host_id;
  }
  throw Error(
    "account_id or project_id or hub_id or host_id must be specified in user",
  );
}

export function checkCommonPermissions({
  user,
  userType,
  userId,
  subject,
  type,
}: {
  user: CoCalcUser;
  userType: "account" | "project" | "host";
  userId: string;
  subject: string;
  type: "sub" | "pub";
}): null | boolean {
  // Any authenticated identity can publish requests to its own hub API subject.
  if (subject.startsWith(`hub.${userType}.${userId}.`)) {
    return type === "pub";
  }

  // Request-reply: allow publish to inbox subjects.
  if (type === "pub" && subject.startsWith("_INBOX.")) {
    return true;
  }

  // Only allow subscribing to this identity's inbox.
  if (type === "sub" && subject.startsWith(inboxPrefix(user))) {
    return true;
  }
  if (type === "sub" && subject.startsWith("_INBOX.")) {
    return false;
  }

  // Public info broadcasts are readable by signed-in users.
  if (type === "sub" && subject.startsWith("public.")) {
    return true;
  }

  return null;
}

export function extractProjectSubject(subject: string): string {
  const parts = subject.split(".");
  if (parts[0] === "project") {
    const project_id = parts[1];
    if (isValidUUID(project_id)) {
      return project_id;
    }
    return "";
  }
  if (parts[0] === "file-server") {
    const project_id = parts[1];
    if (isValidUUID(project_id)) {
      return project_id;
    }
    return "";
  }
  if (parts[0] === "hub" && parts[1] === "project") {
    const project_id = parts[2];
    if (isValidUUID(project_id)) {
      return project_id;
    }
    return "";
  }
  const maybe = parts[1];
  if (maybe?.startsWith("project-")) {
    const project_id = maybe.slice("project-".length);
    if (isValidUUID(project_id)) {
      return project_id;
    }
  }
  return "";
}

export function extractViewerFileSubject(
  subject: string,
): { project_id: string; account_id: string } | undefined {
  const parts = subject.split(".");
  if (parts.length !== 3 || parts[0] !== "fs-viewer") {
    return;
  }
  const project_id = parts[1]?.startsWith("project-")
    ? parts[1].slice("project-".length)
    : "";
  const account_id = parts[2]?.startsWith("account-")
    ? parts[2].slice("account-".length)
    : "";
  if (!isValidUUID(project_id) || !isValidUUID(account_id)) {
    return;
  }
  return { project_id, account_id };
}

export function extractShareFileSubject(
  subject: string,
): { project_id: string; share_id: string; account_id: string } | undefined {
  const parts = subject.split(".");
  if (parts.length !== 4 || parts[0] !== "fs-share") {
    return;
  }
  const project_id = parts[1]?.startsWith("project-")
    ? parts[1].slice("project-".length)
    : "";
  const share_id = parts[2]?.startsWith("share-")
    ? parts[2].slice("share-".length)
    : "";
  const account_id = parts[3]?.startsWith("account-")
    ? parts[3].slice("account-".length)
    : "";
  if (
    !isValidUUID(project_id) ||
    !isValidUUID(share_id) ||
    !isValidUUID(account_id)
  ) {
    return;
  }
  return { project_id, share_id, account_id };
}

export function extractHostSubject(subject: string): string {
  const parts = subject.split(".");
  if (parts[1] === "host") {
    const host_id = parts[2];
    if (isValidUUID(host_id)) {
      return host_id;
    }
  }
  const maybe = parts[1];
  if (maybe?.startsWith("host-")) {
    const host_id = maybe.slice("host-".length, "host-".length + 36);
    if (isValidUUID(host_id)) {
      return host_id;
    }
  }
  return "";
}

export function isProjectAllowed({
  project_id,
  subject,
}: {
  project_id: string;
  subject: string;
}): boolean {
  if (subject.startsWith(`project.${project_id}.`)) {
    return true;
  }
  if (subject.startsWith(`file-server.${project_id}.`)) {
    return true;
  }
  return subject.split(".")[1] === `project-${project_id}`;
}

export function isHostAllowed({
  host_id,
  subject,
}: {
  host_id: string;
  subject: string;
}): boolean {
  if (subject.startsWith(`host.${host_id}.`)) {
    return true;
  }
  return subject.split(".")[1] === `host-${host_id}`;
}

export function isAccountAllowed({
  account_id,
  subject,
}: {
  account_id: string;
  subject: string;
}): boolean {
  if (subject.startsWith(`account.${account_id}.`)) {
    return true;
  }
  return subject.split(".")[1] === `account-${account_id}`;
}

export function isProjectCollaboratorGroup(group: unknown): boolean {
  return group === "owner" || group === "collaborator";
}
