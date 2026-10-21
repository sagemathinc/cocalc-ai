/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "node:events";
import { getLogger } from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";

const logger = getLogger("conat-server");

export type SessionConnection = [id: string, user: any];

// A cookie socket is checked only at its handshake, so signing a session out
// (sign out everywhere, a password change, passkey/2FA setup) must also close
// the sockets that session already has open. Ending a session deletes its
// remember_me row; a socket whose row is gone is disconnected. That includes
// rows maintenance deletes at their hard expiry (max_expire): a session past
// it is over. An idle-expired row that still exists keeps its sockets.
export async function sweepSignedOutSessionConnections({
  connections,
  liveSessionHashes,
  disconnect,
}: {
  connections: SessionConnection[];
  liveSessionHashes: (hashes: string[]) => Promise<Set<string>>;
  disconnect: (ids: string[]) => void;
}): Promise<void> {
  const byHash = new Map<string, string[]>();
  for (const [id, user] of connections) {
    const hash = `${user?.auth_session_hash ?? ""}`;
    if (!hash) continue;
    byHash.set(hash, [...(byHash.get(hash) ?? []), id]);
  }
  if (byHash.size === 0) return;
  let live: Set<string>;
  try {
    live = await liveSessionHashes([...byHash.keys()]);
  } catch (err) {
    // Unlike bay credentials, don't sign every browser out over a database
    // hiccup: the next sweep checks again.
    logger.warn("could not check signed-out sessions", { err: `${err}` });
    return;
  }
  const ids = [...byHash.entries()]
    .filter(([hash]) => !live.has(hash))
    .flatMap(([, ids]) => ids);
  if (ids.length) {
    logger.info("disconnecting signed-out sessions", { count: ids.length });
    disconnect(ids);
  }
}

export async function liveRememberMeHashes(
  hashes: string[],
): Promise<Set<string>> {
  const live = new Set<string>();
  // CHAR(127), like every other remember_me lookup (index use).
  for (let i = 0; i < hashes.length; i += 1000) {
    const { rows } = await getPool().query<{ hash: string }>(
      "SELECT hash FROM remember_me WHERE hash = ANY($1::CHAR(127)[])",
      [hashes.slice(i, i + 1000)],
    );
    for (const { hash } of rows) live.add(`${hash}`.trimEnd());
  }
  return live;
}

// Ending sessions in this process sweeps at once; other hub processes catch
// up on their next periodic sweep.
const sweepRequests = new EventEmitter();

export function requestSignedOutSessionSweep(): void {
  sweepRequests.emit("sweep");
}

export function onSignedOutSessionSweepRequest(fn: () => void): () => void {
  sweepRequests.on("sweep", fn);
  return () => sweepRequests.off("sweep", fn);
}
