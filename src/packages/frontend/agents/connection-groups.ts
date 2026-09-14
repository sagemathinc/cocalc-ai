import type { PersonalConnection } from "@cocalc/conat/agents/personal";

export interface PersonalConnectionGroup {
  id: string;
  connections: PersonalConnection[];
  bidirectional: boolean;
}

function endpointKey(endpoint: PersonalConnection["source"]): string {
  return `${endpoint.project_id}:${endpoint.agent_id}`;
}

export function groupPersonalConnections(
  connections: PersonalConnection[],
): PersonalConnectionGroup[] {
  const groups = new Map<string, PersonalConnection[]>();
  for (const connection of connections) {
    const group = groups.get(connection.direction_group_id);
    if (group) group.push(connection);
    else groups.set(connection.direction_group_id, [connection]);
  }
  return [...groups].map(([id, entries]) => {
    const connections = [...entries].sort(
      (a, b) =>
        endpointKey(a.source).localeCompare(endpointKey(b.source)) ||
        a.link_id.localeCompare(b.link_id),
    );
    const [first, second] = connections;
    const bidirectional =
      connections.length === 2 &&
      endpointKey(first.source) === endpointKey(second.target) &&
      endpointKey(first.target) === endpointKey(second.source);
    return { id, connections, bidirectional };
  });
}

export function latestConnectionObservation(
  connections: PersonalConnection[],
  field: "last_attempt_at" | "last_accepted_at",
): string | undefined {
  let latest: number | undefined;
  for (const connection of connections) {
    const value = connection[field];
    const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isFinite(timestamp) && (latest == null || timestamp > latest))
      latest = timestamp;
  }
  return latest == null ? undefined : new Date(latest).toISOString();
}

export function formatConnectionTime(value?: string | null): string {
  const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString()
    : "Unknown";
}
