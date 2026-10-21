/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A project fence quiesces one project's persistent streams on this persist
server, so that something else can replace their files (e.g., restore the
project's home from a snapshot), and then lets clients open them again.

fenceProject:
1. new opens of the project's disk-backed streams wait (project-fence.ts);
2. opens already under way finish;
3. every server socket serving one of them is closed: clients reconnect with
   backoff, and their opens wait;
4. streams waiting in the release queue are released now, so their databases
   close (checkpointing their WAL);
5. it resolves once no disk-backed stream of the project is open in this
   process.  If that takes longer than timeoutMs, the fence is released and it
   fails, so the caller never replaces files that are open.

unfenceProject releases it.  With replaced, the project's streams report a
new instance from then on, so clients drop what they have and load the new
history, instead of resuming from seqs of the old files (as for a new
ephemeral instance, see client.ts noteInstance).

Ephemeral streams are not affected: they have no files.

Other processes fence a project through the persist fence service below,
e.g., project-host's main process while the persist server runs as its own
daemon.  Only the host's system account may use its subject (project-host
conat-auth.ts).  A fence there is a lease: its holder renews it, and one not
renewed within its ttl is released, as replaced, since its holder may have
replaced files before it went away.

Known limit: the fences are in memory.  If the persist server restarts while
a project is fenced, the new one does not know, and clients can open the
project's streams while its files are being replaced.
*/

import { type Client, ConatError } from "@cocalc/conat/core/client";
import { getLogger } from "@cocalc/conat/logger";
import { randomId } from "@cocalc/conat/names";
import { isValidUUID } from "@cocalc/util/misc";
import { delay } from "awaiting";
import { openDiskStreamPaths } from "./storage";
import { releaseQueuedStreams } from "./server";
import { resolveLocalPath } from "./util";
import {
  beginProjectFence,
  closeProjectSockets,
  endProjectFence,
  waitForProjectOpens,
} from "./project-fence";

const logger = getLogger("persist:fence");

export const PERSIST_FENCE_SUBJECT = "persist-control.fence";

export const DEFAULT_FENCE_TIMEOUT_MS = 60_000;
export const DEFAULT_FENCE_TTL_MS = 120_000;
const MIN_TTL_MS = 5_000;
const MAX_TTL_MS = 30 * 60_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 25;

// Where the project's disk-backed streams live on this server; every one is
// this path or under it.
function projectStreamsRoot(project_id: string): string {
  return resolveLocalPath(`projects/${project_id}`, { ephemeral: true });
}

function underRoot(root: string): (path: string) => boolean {
  return (path) => path === root || path.startsWith(`${root}/`);
}

export function openProjectStreamPaths(project_id: string): string[] {
  return openDiskStreamPaths().filter(
    underRoot(projectStreamsRoot(project_id)),
  );
}

export async function fenceProject({
  project_id,
  token,
  timeoutMs = DEFAULT_FENCE_TIMEOUT_MS,
}: {
  project_id: string;
  token: string;
  timeoutMs?: number;
}): Promise<{ closed_sockets: number }> {
  beginProjectFence(project_id, token);
  const deadline = Date.now() + timeoutMs;
  try {
    if (!(await waitForProjectOpens(project_id, deadline - Date.now()))) {
      throw new ConatError(
        "timed out waiting for opens of this project's persistent streams",
        { code: 504 },
      );
    }
    const under = underRoot(projectStreamsRoot(project_id));
    const closed_sockets = closeProjectSockets(project_id);
    while (true) {
      await releaseQueuedStreams(under);
      const open = openDiskStreamPaths().filter(under);
      if (open.length == 0) {
        logger.debug("fenced project", { project_id, closed_sockets });
        return { closed_sockets };
      }
      if (Date.now() >= deadline) {
        logger.warn("project fence: streams did not close", {
          project_id,
          open: open.slice(0, 10),
        });
        throw new ConatError(
          `timed out closing ${open.length} of this project's persistent streams`,
          { code: 504 },
        );
      }
      await delay(POLL_MS);
    }
  } catch (err) {
    endProjectFence(project_id, token, { replaced: false });
    throw err;
  }
}

export function unfenceProject({
  project_id,
  token,
  replaced,
}: {
  project_id: string;
  token: string;
  replaced: boolean;
}): boolean {
  return endProjectFence(project_id, token, { replaced });
}

export type PersistFenceRequest =
  | {
      cmd: "acquire";
      project_id: string;
      token: string;
      ttl_ms?: number;
      timeout_ms?: number;
    }
  | { cmd: "renew"; project_id: string; token: string; ttl_ms?: number }
  | { cmd: "release"; project_id: string; token: string; replaced?: boolean };

function boundedMs(
  value: unknown,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// The persist fence service, for the persist server in this process.
export function initPersistFenceService({ client }: { client: Client }): {
  close: () => void;
} {
  // lease expiry, by project
  const leases = new Map<
    string,
    { token: string; timer: ReturnType<typeof setTimeout> }
  >();
  // acquires under way, by token, so a retried acquire joins the first
  const acquiring = new Map<string, Promise<{ closed_sockets: number }>>();

  const armLease = (project_id: string, token: string, ttl: number) => {
    const current = leases.get(project_id);
    if (current != null) clearTimeout(current.timer);
    const timer = setTimeout(() => {
      if (leases.get(project_id)?.token !== token) return;
      leases.delete(project_id);
      if (unfenceProject({ project_id, token, replaced: true })) {
        logger.warn("project fence lease expired; released it", {
          project_id,
        });
      }
    }, ttl);
    timer.unref?.();
    leases.set(project_id, { token, timer });
  };

  const handle = async (request: PersistFenceRequest) => {
    const { cmd, project_id, token } = request ?? ({} as PersistFenceRequest);
    if (!isValidUUID(project_id)) {
      throw new ConatError("invalid project_id", { code: 400 });
    }
    if (typeof token != "string" || !token || token.length > 128) {
      throw new ConatError("invalid token", { code: 400 });
    }
    if (request.cmd == "acquire") {
      const ttl = boundedMs(request.ttl_ms, {
        min: MIN_TTL_MS,
        max: MAX_TTL_MS,
        fallback: DEFAULT_FENCE_TTL_MS,
      });
      const timeoutMs = boundedMs(request.timeout_ms, {
        min: 1000,
        max: MAX_TIMEOUT_MS,
        fallback: DEFAULT_FENCE_TIMEOUT_MS,
      });
      const key = `${project_id}/${token}`;
      let pending = acquiring.get(key);
      if (pending == null) {
        pending = fenceProject({ project_id, token, timeoutMs });
        acquiring.set(key, pending);
        void pending
          .then(
            () => armLease(project_id, token, ttl),
            () => {},
          )
          .finally(() => acquiring.delete(key));
      }
      return { ...(await pending), ttl_ms: ttl };
    }
    if (request.cmd == "renew") {
      const lease = leases.get(project_id);
      if (lease == null || lease.token !== token) {
        throw new ConatError("this fence is not held", { code: 404 });
      }
      const ttl = boundedMs(request.ttl_ms, {
        min: MIN_TTL_MS,
        max: MAX_TTL_MS,
        fallback: DEFAULT_FENCE_TTL_MS,
      });
      armLease(project_id, token, ttl);
      return { ttl_ms: ttl };
    }
    if (request.cmd == "release") {
      // An acquire still under way finishes first, so it cannot take the
      // fence after this release.
      await acquiring.get(`${project_id}/${token}`)?.catch(() => {});
      const lease = leases.get(project_id);
      if (lease?.token === token) {
        clearTimeout(lease.timer);
        leases.delete(project_id);
      }
      const released = unfenceProject({
        project_id,
        token,
        replaced: request.replaced !== false,
      });
      return { released };
    }
    throw new ConatError(`unknown command ${cmd}`, { code: 400 });
  };

  let closed = false;
  let sub: any = undefined;
  (async () => {
    while (!closed) {
      try {
        sub = await client.subscribe(PERSIST_FENCE_SUBJECT);
        for await (const mesg of sub) {
          void (async () => {
            try {
              mesg.respondSync(await handle(mesg.data));
            } catch (err) {
              mesg.respondSync(null, {
                headers: {
                  error: `${(err as any)?.message ?? err}`,
                  code: (err as any)?.code ?? 500,
                },
              });
            }
          })();
        }
      } catch (err) {
        logger.debug("persist fence service: restarting", { err: `${err}` });
      } finally {
        sub?.close();
        sub = undefined;
      }
      if (!closed) await delay(3000);
    }
  })();

  return {
    close: () => {
      closed = true;
      sub?.close();
      for (const { timer } of leases.values()) clearTimeout(timer);
      leases.clear();
    },
  };
}

export class PersistFenceUnavailableError extends Error {}

// Runs fn while project_id is fenced by the persist fence service, renewing
// the lease meanwhile.  Throws PersistFenceUnavailableError if no persist
// server on client's network offers the service (e.g., an older one), so the
// caller can decide whether to go ahead without it.  Unless replaces is false
// (fn only reads the files), clients load the history again afterwards.
export async function withPersistFence<T>(
  {
    client,
    project_id,
    replaces = true,
    ttlMs = DEFAULT_FENCE_TTL_MS,
    timeoutMs = DEFAULT_FENCE_TIMEOUT_MS,
  }: {
    client: Client;
    project_id: string;
    replaces?: boolean;
    ttlMs?: number;
    timeoutMs?: number;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const token = randomId();
  const request = async (data: PersistFenceRequest, timeout: number) =>
    (await client.request(PERSIST_FENCE_SUBJECT, data, { timeout })).data;
  const release = async (replaced: boolean) => {
    try {
      await request({ cmd: "release", project_id, token, replaced }, 30_000);
    } catch (err) {
      // its lease expires on its own
      logger.warn("failed releasing persist fence", {
        project_id,
        err: `${err}`,
      });
    }
  };
  try {
    await request(
      {
        cmd: "acquire",
        project_id,
        token,
        ttl_ms: ttlMs,
        timeout_ms: timeoutMs,
      },
      timeoutMs + 10_000,
    );
  } catch (err) {
    if (
      (err as any)?.code == 503 &&
      `${(err as any)?.message}`.includes("no subscribers")
    ) {
      throw new PersistFenceUnavailableError(
        `persist fence service unavailable: ${err}`,
      );
    }
    // it may have been acquired after all (e.g., the reply was lost)
    await release(false);
    throw err;
  }
  let lost = false;
  const renew = setInterval(
    () => {
      void request({ cmd: "renew", project_id, token, ttl_ms: ttlMs }, 15_000)
        .then(() => {
          lost = false;
        })
        .catch((err) => {
          lost = true;
          logger.warn("failed renewing persist fence", {
            project_id,
            err: `${err}`,
          });
        });
    },
    Math.max(1000, Math.floor(ttlMs / 4)),
  );
  renew.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(renew);
    if (lost) {
      logger.warn("persist fence may have lapsed while it was held", {
        project_id,
      });
    }
    // even if fn failed: it may have replaced some files
    await release(replaces);
  }
}
