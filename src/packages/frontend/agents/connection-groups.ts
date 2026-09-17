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

export interface PersonalConnectionPair {
  id: string;
  visible: PersonalConnectionGroup[];
  history: PersonalConnectionGroup[];
}

export function groupPersonalConnectionPairs(
  connections: PersonalConnection[],
  now = Date.now(),
): PersonalConnectionPair[] {
  const pairs = new Map<string, PersonalConnectionGroup[]>();
  for (const group of groupPersonalConnections(connections)) {
    const first = group.connections[0];
    const id = JSON.stringify(
      [endpointKey(first.source), endpointKey(first.target)].sort(),
    );
    const entries = pairs.get(id) ?? [];
    entries.push(group);
    pairs.set(id, entries);
  }
  const created = (group: PersonalConnectionGroup) =>
    Math.max(
      ...group.connections.map((entry) => Date.parse(entry.created_at) || 0),
    );
  return [...pairs].map(([id, groups]) => {
    groups.sort((a, b) => created(b) - created(a) || a.id.localeCompare(b.id));
    // Paused, unexpired approvals still carry independent authority. Never
    // hide them behind a newer approval whose controls cannot revoke them.
    const current = groups.filter((group) =>
      group.connections.some(
        (entry) =>
          entry.status !== "revoked" &&
          entry.status !== "expired" &&
          !(entry.expires_at != null && Date.parse(entry.expires_at) <= now),
      ),
    );
    const visible = current.length ? current : groups.slice(0, 1);
    return { id, visible, history: groups.filter((g) => !visible.includes(g)) };
  });
}

/** Summarize usable permissions, not historical approvals or delivery success. */
export function summarizeConnectionPair(
  pair: PersonalConnectionPair,
  paused = false,
  now = Date.now(),
) {
  const entries = pair.visible.flatMap((group) => group.connections);
  const { source, target } = entries[0];
  const active = entries.filter(
    (entry) =>
      entry.status === "active" &&
      !entry.paused &&
      (entry.expires_at == null || Date.parse(entry.expires_at) > now),
  );
  const forward = active.some(
    (entry) => endpointKey(entry.source) === endpointKey(source),
  );
  const reverse = active.some(
    (entry) => endpointKey(entry.source) === endpointKey(target),
  );
  const hasPaused = entries.some(
    (entry) =>
      (entry.paused || entry.status === "paused") &&
      entry.status !== "revoked" &&
      entry.status !== "expired" &&
      (entry.expires_at == null || Date.parse(entry.expires_at) > now),
  );
  const label = paused
    ? "Paused globally"
    : forward && reverse
      ? "Both ways"
      : forward || reverse
        ? "One way"
        : hasPaused
          ? "Paused"
          : "None";
  const symbol =
    paused || (!forward && !reverse)
      ? "-"
      : forward && reverse
        ? "↕"
        : forward
          ? "↓"
          : "↑";
  return {
    source,
    target,
    label,
    symbol,
    forward: !paused && forward,
    reverse: !paused && reverse,
  };
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
