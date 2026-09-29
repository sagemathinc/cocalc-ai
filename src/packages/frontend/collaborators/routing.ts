import type { CollaboratorsRoute } from "./workspace-types";
import type { PrivateAliasKind } from "@cocalc/util/private-alias";
import { personalUrlPath } from "@cocalc/util/personal-urls";

export type ParsedCollaboratorsRoute = Partial<CollaboratorsRoute> & {
  routeError?: string;
};

export function parsePrivateAliasRoute(
  kind: PrivateAliasKind,
  parts: string[],
): ParsedCollaboratorsRoute {
  const view = kind === "people" ? "people" : "conversations";
  if (parts.length === 0 || (parts.length === 1 && !parts[0]))
    return { view, aliasKind: kind };
  return {
    view,
    routeError:
      "Personal alias addresses must include their owner (/u/owner/...).",
  };
}

export function parseCollaboratorsRoute(
  parts: string[],
  search = "",
): ParsedCollaboratorsRoute {
  // Accept one conventional trailing slash without hiding empty interior segments.
  if (parts.at(-1) === "") parts = parts.slice(0, -1);
  if (parts.length === 0) {
    return { view: "conversations" };
  }
  const [segment, ...rest] = parts;
  const view = segment === "collaborators" ? "people" : segment;
  if (!["conversations", "people", "projects", "invites"].includes(view)) {
    return { routeError: "This People address is not valid." };
  }
  const result: ParsedCollaboratorsRoute = {
    view: view as CollaboratorsRoute["view"],
  };
  const seen = new Set<string>();
  try {
    while (rest.length) {
      const key = rest.shift()!;
      if (seen.has(key)) throw Error();
      seen.add(key);
      if (key === "resource") {
        const kind = rest.shift();
        if (!kind || !["conversation", "agent", "artifact"].includes(kind))
          throw Error();
        result.resourceKind = kind as CollaboratorsRoute["resourceKind"];
      } else if (
        key !== "project" &&
        key !== "person" &&
        key !== "contact" &&
        key !== "projects"
      ) {
        throw Error();
      }
      const value = decodeURIComponent(rest.shift() ?? "");
      if (
        !value ||
        value.length > 2048 ||
        /[\u0000-\u001f]/.test(value) ||
        (key !== "resource" && value.includes("/"))
      )
        throw Error();
      if (key === "project") result.projectId = value;
      else if (key === "projects") {
        const ids = value.split(",");
        if (
          ids.length > 50 ||
          ids.some(
            (id) => !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id),
          )
        )
          throw Error();
        result.projectIds = [...new Set(ids)];
      } else if (key === "contact") {
        if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value))
          throw Error();
        result.contactId = value;
      } else if (key === "person") result.personId = value;
      else result.resourceId = value;
    }
    if (result.resourceId && !result.projectId) throw Error();
    if (view === "invites") {
      const ids = new URLSearchParams(search).getAll("invitation_id");
      if (ids.length > 1) throw Error();
      if (ids.length) {
        if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(ids[0]))
          throw Error();
        result.invitationId = ids[0];
      }
    }
    return result;
  } catch {
    return { routeError: "This People address is not valid." };
  }
}

export function collaboratorsTargetPath(
  route: ParsedCollaboratorsRoute,
): string {
  if (route.aliasKind && !route.contactId && route.view !== "invites") {
    if (route.alias && route.aliasOwner)
      return personalUrlPath(
        route.aliasOwner,
        route.aliasKind,
        route.alias,
      ).slice(1);
  }
  if (route.routeError) return "people/invalid";
  const parts = [
    "people",
    route.view === "people" ? "collaborators" : (route.view ?? "conversations"),
  ];
  if (route.projectId) parts.push("project", route.projectId);
  if (route.projectIds?.length)
    parts.push("projects", route.projectIds.join(","));
  if (route.personId) parts.push("person", route.personId);
  if (route.contactId) parts.push("contact", route.contactId);
  if (route.resourceKind && route.resourceId)
    parts.push("resource", route.resourceKind, route.resourceId);
  const path = parts.map(encodeURIComponent).join("/");
  return route.view === "invites" && route.invitationId
    ? `${path}?invitation_id=${encodeURIComponent(route.invitationId)}`
    : path;
}
