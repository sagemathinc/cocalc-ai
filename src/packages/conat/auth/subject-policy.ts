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
    }
  | {
      account_id?: string;
      project_id?: string;
      hub_id: string;
      host_id?: string;
      error?: string;
      auth_iat_s?: number;
    }
  | {
      account_id?: string;
      project_id: string;
      hub_id?: string;
      host_id?: string;
      error?: string;
      auth_iat_s?: number;
    }
  | {
      account_id?: string;
      project_id?: string;
      hub_id?: string;
      host_id: string;
      error?: string;
      auth_iat_s?: number;
    }
  | {
      account_id?: string;
      project_id?: string;
      hub_id?: string;
      host_id?: string;
      error: string;
      auth_iat_s?: number;
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

  // Public info broadcasts are readable by signed-in users.
  if (type === "sub" && subject.startsWith("public.")) {
    return true;
  }

  return null;
}

export function extractProjectSubject(subject: string): string {
  if (subject.startsWith("project.")) {
    const project_id = subject.split(".")[1];
    if (isValidUUID(project_id)) {
      return project_id;
    }
    return "";
  }
  const parts = subject.split(".");
  const maybe = parts[1];
  if (maybe?.startsWith("project-")) {
    const project_id = maybe.slice("project-".length);
    if (isValidUUID(project_id)) {
      return project_id;
    }
  }
  return "";
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
