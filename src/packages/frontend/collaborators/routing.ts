import type { CollaboratorsRoute } from "./workspace-types";

export type ParsedCollaboratorsRoute = Partial<CollaboratorsRoute> & {
  routeError?: string;
};

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
      } else if (key !== "project" && key !== "person") {
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
      else if (key === "person") result.personId = value;
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
  if (route.routeError) return "collaborators/invalid";
  const parts = ["collaborators", route.view ?? "conversations"];
  if (route.projectId) parts.push("project", route.projectId);
  if (route.personId) parts.push("person", route.personId);
  if (route.resourceKind && route.resourceId)
    parts.push("resource", route.resourceKind, route.resourceId);
  return parts.map(encodeURIComponent).join("/");
}
