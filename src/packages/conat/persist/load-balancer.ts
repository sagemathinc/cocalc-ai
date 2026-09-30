/*
The persist load balancer listens for requests on the subject

   {SERVICE}.{scope}.id

- SERVICE (e.g., 'persist')
- scope it typically hub or account-...or project-....
- id is literally that.

It then responds with a persist server id from the ones that got started.
The persist server id is just a function of the scope, i.e,. we
just shard accounts and projects across the persist server, and that's
it.  The most important thing is that this assignment never changes
(unless you restart servers), because if two clients both fetch the
id for the same scope, they must get something on the same persist
server, since otherwise things could be out of sync.

If somehow two clients got different id's, that' wouldn't corrupt data on disk.
We always run different persist servers on the same machine with the same disk,
so since data is written with sqlite lite, nothing will literally be out sync,
since sqlite has locks and allows multiple processes to write to the same file.
However, the *change* events will not properly get sent out, and that will break
collaborative editing badly.
*/

import { type Client } from "@cocalc/conat/core/client";
import { getLogger } from "@cocalc/conat/logger";
import { SERVICE } from "./util";
import { hash_string } from "@cocalc/util/misc";
import { delay } from "awaiting";
import type { SocketServerInfo } from "../socket/util";

const logger = getLogger("persist:load-balancer");

export function initLoadBalancer({
  client,
  ids,
  service = SERVICE,
}: {
  client: Client;
  ids: string[];
  service?: string;
}) {
  if (ids.length == 0) {
    throw Error("there must be at least 1 id");
  }

  const subject = `${service}.*.id`;

  // I don't think subscription ever randomly throw errors, but this
  // is so important I'm making it extra paranoid:
  (async () => {
    while (true) {
      let sub: any = undefined;
      try {
        logger.debug("creating persist load balancer: ", { subject, ids });
        sub = await client.subscribe(subject);
        for await (const mesg of sub) {
          const id = getId(ids, mesg.subject);
          mesg.respondSync(getPersistServerDiscoveryResponse(id));
        }
      } catch (err) {
        sub?.close();
        logger.debug("ERROR (restarting) -- ", err);
      }
      await delay(3000);
    }
  })();
}

// Keep persistence sockets on their project-scoped return subjects. Confined
// inbox returns cannot be advertised until routed clients bind the inbox
// subscription to the same project-host transport as the socket request.
export function getPersistServerDiscoveryResponse(id: string): string {
  return id;
}

// we use a hash so that this takes NO memory, but the assignment
// lasts forever, which means our sharding by server doesn't
// take into account load at all.  This keeps things much, much
// simpler, and should be fine in practice.
export function getId(ids: string[], subject: string) {
  const h = Math.abs(hash_string(subject.split(".")[1]));
  const id = ids[h % ids.length];
  //logger.debug("getId", { ids, subject, id });
  return id;
}

// This is intentionally bounded.  We want to collapse repeated lookups during
// one bootstrap burst, including slower remote opens, without pinning a client
// to a persist server for the lifetime of the client if the persist service
// restarts.
export const PERSIST_SERVER_ID_CACHE_TTL_MS = 15000;
export const PERSIST_SERVER_ID_REQUEST_TIMEOUT_MS = 2000;

type CacheEntry = {
  promise: Promise<SocketServerInfo>;
  expiresAt: number;
};

const persistServerIdCache = new WeakMap<Client, Map<string, CacheEntry>>();

function getPersistServerIdCache(client: Client) {
  let cache = persistServerIdCache.get(client);
  if (cache != null) {
    return cache;
  }
  const newCache = new Map<string, CacheEntry>();
  const clear = () => newCache.clear();
  client.on("disconnected", clear);
  client.on("closed", clear);
  persistServerIdCache.set(client, newCache);
  return newCache;
}

export function clearPersistServerIdCache(client: Client) {
  persistServerIdCache.get(client)?.clear();
}

export async function getPersistServerId(opts: {
  client: Client;
  subject: string;
}): Promise<string> {
  return (await getPersistServerInfo(opts)).id;
}

export async function getPersistServerInfo({
  client,
  subject,
}: {
  client: Client;
  subject: string;
}) {
  // take only first two segments of subject, since it could have a bunch more
  // that we better ignore (e.g., from the client)
  const s = subject.split(".").slice(0, 2).join(".") + ".id";
  const cache = getPersistServerIdCache(client);
  const now = Date.now();
  let entry = cache.get(s);
  if (
    entry != null &&
    (entry.expiresAt === Number.POSITIVE_INFINITY || entry.expiresAt > now)
  ) {
    return await entry.promise;
  }
  entry = {
    expiresAt: now + PERSIST_SERVER_ID_REQUEST_TIMEOUT_MS,
    promise: client
      .request(s, null, {
        timeout: PERSIST_SERVER_ID_REQUEST_TIMEOUT_MS,
        headers: { socketInfo: 1 },
      })
      .then((resp) => {
        const info =
          typeof resp.data === "string" ? { id: resp.data } : resp.data;
        if (!info || typeof info.id !== "string" || !info.id.length) {
          throw Error("invalid persist server discovery response");
        }
        entry!.expiresAt = Date.now() + PERSIST_SERVER_ID_CACHE_TTL_MS;
        return {
          id: info.id,
          ...(info.inboxReturn === 1 ? { inboxReturn: 1 as const } : {}),
        };
      })
      .catch((err) => {
        if (cache.get(s) === entry) {
          cache.delete(s);
        }
        throw err;
      }),
  };
  cache.set(s, entry);
  return await entry.promise;
}
