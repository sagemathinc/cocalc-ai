export const SERVICE = "changefeeds";
export const SUBJECT = "changefeeds.*";

// This is the max *per account* connected to a single server, just
// because everything should have limits.
// Changefeeds now use transport-scoped liveness instead of per-socket
// ping/pong, so orphaned sockets are reclaimed by server-side interest
// sweeps controlled by KEEPALIVE_TIMEOUT below.
export const MAX_PER_ACCOUNT = 1_000;
export const MAX_GLOBAL = 50_000;

const DEBUG_DEVEL_MODE = false;

export let CLIENT_KEEPALIVE = 120_000;
export let SERVER_KEEPALIVE = 60_000;
export let KEEPALIVE_TIMEOUT = 30_000;

if (DEBUG_DEVEL_MODE) {
  console.log(
    "*** WARNING: Using DEBUG_DEVEL_MODE changefeed parameters!! ***",
  );
  CLIENT_KEEPALIVE = 6000;
  SERVER_KEEPALIVE = 3000;
  KEEPALIVE_TIMEOUT = 1000;
}

export const RESOURCE = "PostgreSQL changefeeds";
