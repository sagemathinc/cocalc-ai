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
ephemeral instance, see client.ts noteInstance).  And nothing based on the
old files is written to the new ones:
- a write from a client that saw another instance is refused, with the
  current one (server.ts assertCurrentInstance), so the client starts over;
- a DStream keeps what it had not saved for its owner instead of writing it
  (dstream.ts handleInstanceReset), and SyncDoc saves it to a recovery copy;
  a DKV drops it (dkv.ts handleInstanceReset).

Ephemeral streams are not affected: they have no files.

Other processes fence a project through the persist fence service below,
e.g., project-host's main process while the persist server runs as its own
daemon.  Only the host's system account may use its subject (project-host
conat-auth.ts).  A fence there fails closed: it is held until its holder, a
process on this host, releases it, or until it and whatever it started since
the fence was taken (its process group) are gone, never for a fixed time, so
it cannot lapse while the files may still be changing.  The service keeps in a store the fences it holds, which a restarted
service holds again before its persist server serves, and each replaced
project's instance, saved before the fence is released: a client that last
saw the project before a restart must still learn that it was replaced.
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
  isProjectFencedBy,
  setProjectReplacedInstance,
  waitForProjectOpens,
} from "./project-fence";

const logger = getLogger("persist:fence");

export const PERSIST_FENCE_SUBJECT = "persist-control.fence";

export const DEFAULT_FENCE_TIMEOUT_MS = 60_000;
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
  instance,
}: {
  project_id: string;
  token: string;
  replaced: boolean;
  instance?: string;
}): boolean {
  return endProjectFence(project_id, token, { replaced, instance });
}

export interface PersistFenceHolder {
  pid: number;
  // the process's start time, so a reused pid is a different holder
  start: string;
  // its process group: what it runs to change the files (e.g., rustic, or
  // sudo waiting for a helper) is in it, and may outlive it
  pgid?: number;
}

export interface PersistFenceRecord {
  project_id: string;
  token: string;
  holder: PersistFenceHolder;
  since: number;
}

// Where a fence service keeps the fences it holds, so it still holds them
// after a restart, and the instance of each project whose files were
// replaced, so its streams keep reporting it (by project).
export interface PersistFenceStore {
  load: () => PersistFenceRecord[];
  save: (record: PersistFenceRecord) => void;
  remove: (project_id: string, token: string) => void;
  loadInstances: () => { [project_id: string]: string };
  saveInstance: (project_id: string, instance: string) => void;
}

export type PersistFenceRequest =
  | {
      cmd: "acquire";
      project_id: string;
      token: string;
      holder: PersistFenceHolder;
      timeout_ms?: number;
    }
  | { cmd: "release"; project_id: string; token: string; replaced?: boolean };

const MAX_TIMEOUT_MS = 5 * 60_000;
// how often the service checks that the holders of its fences still run
const DEFAULT_HOLDER_CHECK_MS = 5_000;
// A fence held longer than this is logged (and kept: see above).
const LONG_FENCE_MS = 60 * 60_000;

function boundedMs(
  value: unknown,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function isHolder(holder: unknown): holder is PersistFenceHolder {
  const h = holder as PersistFenceHolder;
  return (
    h != null &&
    Number.isSafeInteger(h.pid) &&
    h.pid > 0 &&
    typeof h.start == "string" &&
    h.start.length <= 64 &&
    (h.pgid == null || (Number.isSafeInteger(h.pgid) && h.pgid > 0))
  );
}

// The persist fence service, for the persist server in this process.  Start
// it before the persist server serves: it first holds again the fences in
// store whose holders still run.  Resolves once it is subscribed.
export async function initPersistFenceService({
  client,
  holderAlive,
  store,
  holderCheckMs = DEFAULT_HOLDER_CHECK_MS,
}: {
  client: Client;
  // whether holder, or anything it started (since the fence was taken, at
  // since) to change the files, still runs
  holderAlive: (holder: PersistFenceHolder, since: number) => boolean;
  store?: PersistFenceStore;
  holderCheckMs?: number;
}): Promise<{ close: () => void }> {
  // the fences this service holds, by project
  const held = new Map<string, PersistFenceRecord>();
  // acquires under way, by project and token, so a retried acquire joins
  // the first
  const acquiring = new Map<string, Promise<{ closed_sockets: number }>>();

  // Releases a fence this service holds.  A replacement's new instance is
  // saved first: if that fails, the fence stays held (and this throws).
  const releaseFence = ({
    project_id,
    token,
    replaced,
  }: {
    project_id: string;
    token: string;
    replaced: boolean;
  }): boolean => {
    if (!isProjectFencedBy(project_id, token)) return false;
    const instance = replaced ? randomId() : undefined;
    if (instance != null) {
      store?.saveInstance(project_id, instance);
    }
    const record = held.get(project_id);
    if (record?.token === token) {
      forget(record);
    }
    return unfenceProject({ project_id, token, replaced, instance });
  };

  const forget = (record: PersistFenceRecord) => {
    if (held.get(record.project_id)?.token === record.token) {
      held.delete(record.project_id);
    }
    try {
      store?.remove(record.project_id, record.token);
    } catch (err) {
      logger.warn("unable to remove a persist fence from its store", {
        project_id: record.project_id,
        err: `${err}`,
      });
    }
  };

  for (const [project_id, instance] of Object.entries(
    store?.loadInstances() ?? {},
  )) {
    setProjectReplacedInstance(project_id, instance);
  }
  // Held again, whether or not the holder still runs: one that is gone may
  // have replaced files before it went away, so its fence is released by
  // checkHolders below (before this resolves), as replaced, like any other.
  for (const record of store?.load() ?? []) {
    beginProjectFence(record.project_id, record.token);
    held.set(record.project_id, record);
    logger.warn("holding a persist fence again after a restart", {
      project_id: record.project_id,
      holder: record.holder,
    });
  }

  const checkHolders = () => {
    const now = Date.now();
    for (const record of [...held.values()]) {
      if (holderAlive(record.holder, record.since)) {
        if (now - record.since > LONG_FENCE_MS) {
          logger.warn("a persist fence has been held for a long time", {
            project_id: record.project_id,
            holder: record.holder,
            since: new Date(record.since).toISOString(),
          });
        }
        continue;
      }
      try {
        // it may have replaced files before it went away
        if (
          releaseFence({
            project_id: record.project_id,
            token: record.token,
            replaced: true,
          })
        ) {
          logger.warn("released a persist fence whose holder is gone", {
            project_id: record.project_id,
            holder: record.holder,
          });
        }
      } catch (err) {
        // still held; tried again next time
        logger.warn("unable to release a persist fence whose holder is gone", {
          project_id: record.project_id,
          err: `${err}`,
        });
      }
    }
  };
  checkHolders();
  const checker = setInterval(checkHolders, holderCheckMs);
  checker.unref?.();

  const handle = async (request: PersistFenceRequest) => {
    const { cmd, project_id, token } = request ?? ({} as PersistFenceRequest);
    if (!isValidUUID(project_id)) {
      throw new ConatError("invalid project_id", { code: 400 });
    }
    if (typeof token != "string" || !token || token.length > 128) {
      throw new ConatError("invalid token", { code: 400 });
    }
    if (request.cmd == "acquire") {
      const { holder } = request;
      if (!isHolder(holder) || !holderAlive(holder, Date.now())) {
        throw new ConatError("the fence holder is not a running process", {
          code: 400,
        });
      }
      const timeoutMs = boundedMs(request.timeout_ms, {
        min: 1000,
        max: MAX_TIMEOUT_MS,
        fallback: DEFAULT_FENCE_TIMEOUT_MS,
      });
      const key = `${project_id}/${token}`;
      let pending = acquiring.get(key);
      if (pending == null) {
        pending = (async () => {
          const result = await fenceProject({ project_id, token, timeoutMs });
          const record = { project_id, token, holder, since: Date.now() };
          try {
            store?.save(record);
          } catch (err) {
            // not held unless it would be held again after a restart
            unfenceProject({ project_id, token, replaced: false });
            throw err;
          }
          held.set(project_id, record);
          return result;
        })();
        acquiring.set(key, pending);
        void pending.catch(() => {}).finally(() => acquiring.delete(key));
      }
      return await pending;
    }
    if (request.cmd == "release") {
      // An acquire still under way finishes first, so it cannot take the
      // fence after this release.
      await acquiring.get(`${project_id}/${token}`)?.catch(() => {});
      const released = releaseFence({
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
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => (resolveReady = resolve));
  (async () => {
    while (!closed) {
      try {
        sub = await client.subscribe(PERSIST_FENCE_SUBJECT);
        resolveReady();
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
      if (!closed) await delay(1000);
    }
  })();
  await ready;

  return {
    close: () => {
      closed = true;
      clearInterval(checker);
      sub?.close();
    },
  };
}

// No fence service answered.  The caller decides whether that can only be a
// persist server from before fences (then it may go ahead unfenced) or a
// passing gap (then it must not).
export class PersistFenceUnavailableError extends Error {}

// Runs fn while project_id is fenced by the persist fence service, held by
// holder (this process).  Unless replaces is false (fn only reads the files),
// clients load the history again afterwards.  If the release does not get
// through, it is retried until it does; meanwhile the project stays fenced
// (as it does if this process exits first, until the service sees that).
export async function withPersistFence<T>(
  {
    client,
    project_id,
    holder,
    replaces = true,
    timeoutMs = DEFAULT_FENCE_TIMEOUT_MS,
  }: {
    client: Client;
    project_id: string;
    holder: PersistFenceHolder;
    replaces?: boolean;
    timeoutMs?: number;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const token = randomId();
  const request = async (data: PersistFenceRequest, timeout: number) =>
    (await client.request(PERSIST_FENCE_SUBJECT, data, { timeout })).data;
  const releaseOnce = async (replaced: boolean): Promise<boolean> => {
    try {
      await request({ cmd: "release", project_id, token, replaced }, 30_000);
      return true;
    } catch (err) {
      logger.warn("failed releasing persist fence", {
        project_id,
        err: `${err}`,
      });
      return false;
    }
  };
  // One attempt now; then in the background until it gets through.
  const release = async (replaced: boolean) => {
    if (await releaseOnce(replaced)) return;
    void (async () => {
      for (let attempt = 1; client.state != "closed"; attempt++) {
        await delay(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
        if (await releaseOnce(replaced)) return;
      }
    })();
  };
  try {
    await request(
      { cmd: "acquire", project_id, token, holder, timeout_ms: timeoutMs },
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
    void release(false);
    throw err;
  }
  try {
    return await fn();
  } finally {
    // even if fn failed: it may have replaced some files
    await release(replaces);
  }
}
