// This is just the default with socket.io, but we might want a bigger
// size, which could mean more RAM usage by the servers.
// Our client protocol automatically chunks messages, so this payload
// size ONLY impacts performance, never application level constraints.
const MB = 1e6;
export const RESOURCE = "connections to CoCalc";

export const MAX_PAYLOAD = 8 * MB;

export const MAX_SUBSCRIPTIONS_PER_CLIENT = 500;

// hubs must have a much larger limit since they server everybody...
export const MAX_SUBSCRIPTIONS_PER_HUB = 15000;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return Math.floor(n);
}

export const MAX_CONNECTIONS_PER_USER = envNumber(
  "COCALC_CONAT_MAX_CONNECTIONS_PER_USER",
  100,
);

export const MAX_CONNECTIONS_PER_HUB_USER = envNumber(
  "COCALC_CONAT_MAX_CONNECTIONS_PER_HUB_USER",
  1000,
);

export const MAX_CONNECTIONS = envNumber("COCALC_CONAT_MAX_CONNECTIONS", 10000);
