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
): ParsedCollaboratorsRoute {
  if (parts.length === 0 || (parts.length === 1 && parts[0] === "")) {
    return { view: "conversations" };
  }
  const [view, ...rest] = parts;
  if (!["conversations", "people", "projects"].includes(view)) {
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
      } else if (key !== "project" && key !== "person" && key !== "projects") {
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
      } else if (key === "person") result.personId = value;
      else result.resourceId = value;
    }
    if (result.resourceId && !result.projectId) throw Error();
    return result;
  } catch {
    return { routeError: "This People address is not valid." };
  }
}

export function collaboratorsTargetPath(
  route: ParsedCollaboratorsRoute,
): string {
  if (route.aliasKind) {
    if (route.alias && route.aliasOwner)
      return personalUrlPath(
        route.aliasOwner,
        route.aliasKind,
        route.alias,
      ).slice(1);
  }
  if (route.routeError) return "people/invalid";
  const parts = ["people", route.view ?? "conversations"];
  if (route.projectId) parts.push("project", route.projectId);
  if (route.projectIds?.length)
    parts.push("projects", route.projectIds.join(","));
  if (route.personId) parts.push("person", route.personId);
  if (route.resourceKind && route.resourceId)
    parts.push("resource", route.resourceKind, route.resourceId);
  return parts.map(encodeURIComponent).join("/");
}
