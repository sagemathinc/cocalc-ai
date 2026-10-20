/*
CONAT_SERVER=http://localhost:3000 node

// making a server from scratch

// initialize persist context

require('@cocalc/backend/conat/persist');

// a conat server and client
s = require('@cocalc/conat/core/server').init({port:4567, getUser:()=>{return {hub_id:'hub'}}}); client = s.client();

// persist server
p = require('@cocalc/conat/persist/server').server({client}); 0;



// a client for persist server

c = require('@cocalc/conat/persist/client').stream({client, user:{hub_id:'hub'}, storage:{path:'b.txt'}});

for await (x of await c.getAll()) { console.log(x) }


await c.set({messageData:client.message(123)})

for await (x of await c.getAll()) { console.log(x) }

[ { seq: 1, time: 1750218209211, encoding: 0, raw: <Buffer 7b> } ]

(await c.get({seq:5})).data

await c.set({key:'foo', messageData:client.message('bar')})
(await c.get({key:'foo'})).data

await c.delete({seq:6})


client = await require('@cocalc/backend/conat').conat(); kv = require('@cocalc/backend/conat/sync').akv({project_id:'3fa218e5-7196-4020-8b30-e2127847cc4f', name:'a.txt', client})

client = await require('@cocalc/backend/conat').conat(); s = require('@cocalc/backend/conat/sync').astream({project_id:'3fa218e5-7196-4020-8b30-e2127847cc4f', name:'b.txt', client})

client = await require('@cocalc/backend/conat').conat(); s = await require('@cocalc/backend/conat/sync').dstream({project_id:'3fa218e5-7196-4020-8b30-e2127847cc4f', name:'ds2.txt', client})


client = await require('@cocalc/backend/conat').conat(); kv = require('@cocalc/backend/conat/sync').akv({project_id:'3fa218e5-7196-4020-8b30-e2127847cc4f', name:'a.txt', client})


client = await require('@cocalc/backend/conat').conat(); kv = await require('@cocalc/backend/conat/sync').dkv({project_id:'3fa218e5-7196-4020-8b30-e2127847cc4f', name:'a1', client})


client = await require('@cocalc/backend/conat').conat(); s = await require('@cocalc/conat/sync/core-stream').cstream({name:'d.txt',client})


*/

import { type Client, ConatError } from "@cocalc/conat/core/client";
import { validateMessageHeaders } from "../core/message-headers";
import {
  type ConatSocketServer,
  type ServerSocket,
} from "@cocalc/conat/socket";
import {
  type StoredMessage,
  type PersistentStream,
  type StorageOptions,
  type ChangefeedOperation,
  ASYNC_DECOMPRESS_MIN_BYTES,
  maxPersistMessageBytes,
  persistMessageTooLargeError,
  storedRowToMessage,
} from "./storage";
import { getStream, SERVICE, MAX_PER_USER, MAX_GLOBAL, RESOURCE } from "./util";
import {
  assertBoardCommandAllowed,
  boardStreamAccess,
  BOARD_WRITE_CONTROL_RECEIVE_LIMITS,
  BOARD_WRITE_RECEIVE_LIMITS,
  BOARD_WRITE_SERVICE,
  type BoardStreamAccess,
} from "./board-policy";
import {
  assertBoardWriteFence,
  type BoardWriteFence,
} from "./board-write-fence";
import { throttle } from "lodash";
import { type SetOptions } from "./client";
import { once } from "@cocalc/util/async-utils";
import { UsageMonitor } from "@cocalc/conat/monitor/usage";
import { getLogger } from "@cocalc/conat/logger";
import { initLoadBalancer } from "./load-balancer";
import type { PersistMaintenanceHooks } from "./maintenance/types";
import {
  PersistStreamReleaseQueue,
  type PersistStreamReleaseQueueDiagnostics,
} from "./release-queue";

const logger = getLogger("persist:server");

// When sending a large number of message for
// getAll or change updates, we combine together messages
// until hitting this size, then send them all at once.
// This bound is to avoid potentially using a huge amount of RAM
// when streaming a large saved database to the client.
// Note: if a single message is larger than this, it still
// gets sent, just individually.
const DEFAULT_MESSAGES_THRESH = 20 * 1e6;
//const DEFAULT_MESSAGES_THRESH = 1e5;

// I added an experimental way to run any sqlite query... but it is disabled
// since of course there are major DOS and security concerns.
const ENABLE_SQLITE_GENERAL_QUERIES = false;

const SEND_THROTTLE = 30;

// After a socket's stream fails to open, a request retries the open at most
// this often.
const INIT_RETRY_INTERVAL_MS = 1000;

const streamReleaseQueue = new PersistStreamReleaseQueue({
  onError: (err) => {
    logger.warn("error releasing deferred persistent stream", { err });
  },
  onSlowRelease: (durationMs) => {
    logger.warn("slow deferred persistent stream release", {
      duration_ms: durationMs,
    });
  },
});

export function getPersistStreamReleaseQueueDiagnostics(): PersistStreamReleaseQueueDiagnostics {
  return streamReleaseQueue.diagnostics();
}

export async function drainPersistStreamReleaseQueue(): Promise<void> {
  await streamReleaseQueue.drain();
}

export function classifyPersistStorageErrorCode(
  err: unknown,
): string | undefined {
  const code = `${(err as any)?.code ?? ""}`.toUpperCase();
  const errno = `${(err as any)?.errno ?? ""}`.toUpperCase();
  const message = `${(err as any)?.message ?? err ?? ""}`.toLowerCase();
  if (code) return code;
  if (errno) return errno;
  if (message.includes("no space left on device")) return "ENOSPC";
  if (message.includes("disk i/o error")) return "SQLITE_IOERR";
  if (message.includes("input/output error")) return "EIO";
  if (message.includes("database or disk is full")) return "SQLITE_FULL";
  if (message.includes("database disk image is malformed")) {
    return "SQLITE_CORRUPT";
  }
  if (
    message.includes("attempt to write a readonly database") ||
    message.includes("readonly database")
  ) {
    return "SQLITE_READONLY";
  }
  return undefined;
}

export function server({
  client,
  messagesThresh = DEFAULT_MESSAGES_THRESH,
  service = SERVICE,
  id = "0",
  clusterMode,
  maintenance,
  boardWriteFence,
}: {
  client: Client;
  messagesThresh?: number;
  service?: string;
  id?: string;
  // The board write service's fence (board-write-fence.ts), read at each
  // request: it can appear later (the lock is taken in the background) or
  // go away. Without one every board write is refused "lock".
  boardWriteFence?: () => BoardWriteFence | undefined;
  // if false, runs it's own internal load balancer that always returns this server
  clusterMode?: boolean;
  maintenance?: PersistMaintenanceHooks;
}): ConatSocketServer {
  const log = (...args) => {
    logger.debug(id, service, ...args);
  };
  log("server: creating persist server");
  if (client == null) {
    throw Error("client must be specified");
  }
  const subject = `${service}.*`;
  // The board write service is always bounded before reassembly; no caller
  // can start it without these limits.
  const boardWrite = service === BOARD_WRITE_SERVICE;
  const server: ConatSocketServer = client.socket.listen(subject, {
    id,
    keepAlive: 0,
    ...(boardWrite
      ? {
          receiveLimits: BOARD_WRITE_RECEIVE_LIMITS,
          statusReceiveLimits: BOARD_WRITE_CONTROL_RECEIVE_LIMITS,
        }
      : {}),
  });
  log("server listening", { subject, id });
  if (!clusterMode) {
    log("persist server not in cluster mode, so starting own load balancer");
    initLoadBalancer({ service, ids: [id], client });
  }
  const usage = new UsageMonitor({
    maxPerUser: MAX_PER_USER,
    max: MAX_GLOBAL,
    resource: RESOURCE,
    log: (...args) => {
      log(RESOURCE, ...args);
    },
  });

  server.on("close", () => {
    log("stopping persist server", { id, service });
    usage.close();
  });

  server.on("connection", (socket: ServerSocket) => {
    log("server: got new connection", {
      id,
      service,
      subject: socket.subject,
    });
    //     console.log(new Date(), "persist server got connection", {
    //       persist: client.info.id,
    //       subject: socket.subject,
    //     });
    let error = "";
    let errorCode: any = undefined;
    let changefeed = false;
    let stopChangefeed: (() => void) | undefined;
    let storage: undefined | StorageOptions = undefined;
    // What this socket may do with a board stream (board-policy.ts).
    let boardAccess: BoardStreamAccess = { board: false, readOnly: false };
    // The policy refused this socket's stream: never open it (no retry).
    let policyRefused = false;
    let stream: undefined | PersistentStream = undefined;
    let user = "";
    let added = false;
    // in-progress replays on this socket; stopped when it closes
    const replays = new Set<AbortController>();
    let initializing: Promise<void> | undefined;
    let lastInitAttemptAt = 0;
    let closed = false;

    // Open the stream for this socket. A failure is remembered so requests can
    // report it, but it is not permanent: storage errors such as a full project
    // quota are usually transient, and a long-lived client may keep using this
    // socket for hours, so requests retry the open (see retryInit).
    const initStream = (): Promise<void> => {
      if (policyRefused) {
        return Promise.reject(new ConatError(error, { code: errorCode }));
      }
      if (initializing != null) {
        return initializing;
      }
      // Assign before clearing: an attempt that fails before its first await
      // (e.g., usage.add over the limit) settles synchronously, and clearing
      // from inside it would run before this assignment and leave the failed
      // attempt cached forever.
      const attempt = (async () => {
        lastInitAttemptAt = Date.now();
        try {
          if (!added) {
            user = socket.subject.split(".")[1];
            usage.add(user);
            added = true;
          }
          const opened = await getStream({
            subject: socket.subject,
            storage: storage!,
            service,
            maintenance,
          });
          if (closed) {
            streamReleaseQueue.schedule(opened);
            return;
          }
          stream = opened;
          if (error) {
            logger.info("persistent stream initialized after earlier failure", {
              subject: socket.subject,
              path: storage?.path,
              previous_error: error,
            });
          }
          error = "";
          errorCode = undefined;
          if (changefeed) {
            stopChangefeed?.();
            stopChangefeed = startChangefeed({
              socket,
              stream,
              messagesThresh,
            });
          }
        } catch (err) {
          error = `${err}`;
          errorCode =
            (err as any)?.code ??
            classifyPersistStorageErrorCode(err) ??
            (error.includes("permission denied") ? 403 : undefined);
          logger.warn("persistent stream initialization failed", {
            subject: socket.subject,
            path: storage?.path,
            code: errorCode,
            err: error,
          });
          throw err;
        }
      })();
      initializing = attempt;
      const clear = () => {
        if (initializing === attempt) {
          initializing = undefined;
        }
      };
      attempt.then(clear, clear);
      return attempt;
    };

    const retryInit = async (): Promise<void> => {
      if (
        storage == null ||
        policyRefused ||
        errorCode == 403 ||
        Date.now() - lastInitAttemptAt < INIT_RETRY_INTERVAL_MS
      ) {
        return;
      }
      try {
        await initStream();
      } catch {
        // error and errorCode now describe the latest attempt
      }
    };

    socket.on("data", async (data) => {
      // log("server: got data ", data);
      if (stream == null && initializing == null) {
        storage = data.storage;
        changefeed = data.changefeed;
        try {
          // Before the stream is opened or cached: a board stream is read-only
          // here unless this is the host's board write service, and always
          // durable.
          boardAccess = boardStreamAccess({
            service,
            subject: socket.subject,
            storage,
          });
          if (boardAccess.storage != null) {
            // Never the client's options for a board stream.
            storage = boardAccess.storage as StorageOptions;
          }
        } catch (err) {
          policyRefused = true;
          error = `${err}`;
          errorCode = (err as any)?.code ?? 403;
          socket.write(null, { headers: { error, code: errorCode } });
          socket.emit("stream-initialized");
          return;
        }
        try {
          await initStream();
        } catch {
          socket.write(null, { headers: { error, code: errorCode } });
        }
        socket.emit("stream-initialized");
      }
    });
    socket.on("closed", () => {
      log("socket closed", id, socket.subject);
      closed = true;
      stopChangefeed?.();
      stopChangefeed = undefined;
      for (const abort of replays) abort.abort();
      replays.clear();
      storage = undefined;
      if (stream != null) {
        streamReleaseQueue.schedule(stream);
      }
      stream = undefined;
      if (added) {
        usage.delete(user);
      }
    });

    socket.on("request", async (mesg) => {
      // Before anything is awaited: a board write's time to live counts
      // from here.
      const receivedAt = performance.now();
      const request = mesg.headers;
      // log("got request", request);

      try {
        if (stream == null && initializing == null && !error) {
          await once(socket, "stream-initialized", request.timeout ?? 30000);
        } else if (initializing != null) {
          await initializing.catch(() => {});
        }
        if (error) {
          await retryInit();
        }
        if (error) {
          throw new ConatError(error, { code: errorCode });
        }
        if (stream == null) {
          throw Error("bug");
        }
        assertBoardCommandAllowed(boardAccess, request);
        if (boardWrite) {
          // Synchronous, immediately before the store below: a request that
          // fails a check stores nothing.
          assertBoardWriteFence({
            fence: boardWriteFence?.(),
            request,
            receivedAt,
            now: performance.now(),
          });
        }
        if (request.cmd == "set") {
          mesg.respondSync(
            stream.set({
              key: request.key,
              previousSeq: request.previousSeq,
              raw: mesg.raw,
              ttl: request.ttl,
              encoding: mesg.encoding,
              headers: request.headers,
              msgID: request.msgID,
              checkpoint: request.checkpoint,
            }),
          );
        } else if (request.cmd == "setMany") {
          mesg.respondSync(
            stream.setMany(
              (mesg.data as SetOptions[]).map(
                ({
                  key,
                  previousSeq,
                  ttl,
                  msgID,
                  checkpoint,
                  messageData,
                }) => ({
                  key,
                  previousSeq,
                  ttl,
                  headers: messageData.headers,
                  msgID,
                  checkpoint,
                  raw: messageData.raw,
                  encoding: messageData.encoding,
                }),
              ),
            ),
          );
        } else if (request.cmd == "delete") {
          mesg.respondSync(stream.delete(request));
        } else if (request.cmd == "config") {
          mesg.respondSync(stream.config(request.config));
        } else if (request.cmd == "metadata") {
          mesg.respondSync(stream.getMetadata());
        } else if (request.cmd == "setMetadata") {
          mesg.respondSync(stream.setMetadata(mesg.data));
        } else if (request.cmd == "patchMetadata") {
          mesg.respondSync(stream.patchMetadata(mesg.data));
        } else if (request.cmd == "resetHistory") {
          mesg.respondSync(stream.resetHistory(mesg.data ?? {}));
        } else if (request.cmd == "checkpoints") {
          mesg.respondSync(stream.getCheckpoints());
        } else if (request.cmd == "setCheckpoint") {
          mesg.respondSync(stream.setCheckpoint(mesg.data));
        } else if (request.cmd == "deleteCheckpoint") {
          stream.deleteCheckpoint(request.name);
          mesg.respondSync(null);
        } else if (request.cmd == "inventory") {
          mesg.respondSync(stream.inventory());
        } else if (request.cmd == "get") {
          const resp = stream.get({ key: request.key, seq: request.seq });
          //console.log("got resp = ", resp);
          if (resp == null) {
            mesg.respondSync(null);
          } else {
            const { raw, encoding, headers, seq, time, key } = resp;
            mesg.respondSync(null, {
              raw,
              encoding,
              headers: { ...headers, seq, time, key },
            });
          }
        } else if (request.cmd == "keys") {
          const resp = stream.keys();
          mesg.respondSync(resp);
        } else if (request.cmd == "sqlite") {
          if (!ENABLE_SQLITE_GENERAL_QUERIES) {
            throw Error("sqlite command not currently supported");
          }
          const resp = stream.sqlite(request.statement, request.params);
          mesg.respondSync(resp);
        } else if (request.cmd == "serverId") {
          mesg.respondSync(server.id);
        } else if (request.cmd == "boardInstance") {
          // This process's instance nonce (board-write-fence.ts), or null if
          // it may not write board streams.
          mesg.respondSync(
            boardWrite ? (boardWriteFence?.()?.nonce ?? null) : null,
          );
        } else if (request.cmd == "getAll") {
          log("getAll", { subject: socket.subject, request });
          if (request.changefeed && !changefeed) {
            changefeed = true;
            stopChangefeed?.();
            stopChangefeed = startChangefeed({
              socket,
              stream,
              messagesThresh,
            });
          }
          // getAll uses requestMany which responds with all matching messages,
          // so no call to mesg.respond here.
          if (replays.size >= MAX_REPLAYS_PER_SOCKET) {
            throw new ConatError(
              "too many concurrent replays on this connection; try again",
              { code: 503 },
            );
          }
          const abort = new AbortController();
          replays.add(abort);
          try {
            await replay({
              stream,
              mesg,
              request,
              messagesThresh,
              signal: abort.signal,
              changefeedActive: changefeed,
            });
          } finally {
            replays.delete(abort);
          }
        } else if (request.cmd == "changefeed") {
          log("changefeed", changefeed);
          if (!changefeed) {
            changefeed = true;
            stopChangefeed?.();
            stopChangefeed = startChangefeed({
              socket,
              stream,
              messagesThresh,
            });
          }
          mesg.respondSync("created");
        } else {
          mesg.respondSync(null, {
            headers: { error: `unknown command ${request.cmd}`, code: 404 },
          });
        }
      } catch (err) {
        const oversizedSeq = (err as any)?.oversizedSeq;
        mesg.respondSync(null, {
          headers: {
            error: `${err}`,
            code: (err as any)?.code ?? classifyPersistStorageErrorCode(err),
            ...(typeof oversizedSeq == "number"
              ? { oversized_seq: oversizedSeq }
              : {}),
          },
        });
      }
    });
  });

  return server;
}

// Replay pacing.  A replay reads pages bounded by uncompressed bytes,
// decompresses large messages off the event loop, and yields between pages, so
// replaying a huge stream never blocks other requests for long.  (Each page is
// read with complete queries, so no SQLite iterator stays open across a yield.)
const REPLAY_PAGE_ROWS = 1000;
const REPLAY_PAGE_BYTES = 8_000_000;
// While a replay is working on large messages it sends empty frames, so the
// requester's idle timeout (sent with the request) does not expire and trigger
// a retry that starts the whole replay again.
const REPLAY_KEEPALIVE_MS = 1000;
const REPLAY_KEEPALIVE_MIN_MS = 100;

export function replayKeepaliveMs(requestTimeout?: number): number {
  const timeout = Number(requestTimeout);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return REPLAY_KEEPALIVE_MS;
  }
  return Math.max(
    REPLAY_KEEPALIVE_MIN_MS,
    Math.min(REPLAY_KEEPALIVE_MS, Math.floor(timeout / 3)),
  );
}
// Bounds replays piling up on one connection, e.g., from requesters that keep
// retrying; the excess is refused with a retryable error.
const MAX_REPLAYS_PER_SOCKET = 8;

// Every replay page is admitted process-wide before its data is read, weighted
// by its planned (uncompressed) bytes against REPLAY_BUDGET_BYTES, and is sent
// before its admission is released.  So the budget bounds the message data that
// replays hold across all connections, and waiting replays hold none.  A page
// with a message of ASYNC_DECOMPRESS_MIN_BYTES or more weighs at least half the
// budget, so at most two large decompressions run at once (they share the libuv
// threadpool with filesystem I/O); a page over the budget (one huge message)
// weighs the whole budget and runs alone.  At most MAX_WAITING_REPLAY_PAGES
// wait; the excess is refused with a retryable error.
const REPLAY_BUDGET_BYTES = 64_000_000;
const MAX_WAITING_REPLAY_PAGES = 256;
// Each message in a page is charged at least this much, since reading and
// sending it costs objects and work even when it is empty; otherwise a page of
// 1000 empty messages would weigh almost nothing.
const REPLAY_MESSAGE_CHARGE_BYTES = 1024;

export class ReplayAdmission {
  private used = 0;
  private waiting: { weight: number; admit: () => void }[] = [];

  constructor(
    readonly budget: number,
    private readonly maxWaiting: number,
  ) {}

  // Resolves to a release function, or rejects if the signal aborts first or
  // too many are already waiting.  First come, first served, so a stream of
  // small pages cannot starve a large one.
  acquire = async (bytes: number, signal: AbortSignal): Promise<() => void> => {
    signal.throwIfAborted();
    const weight = Math.min(Math.max(1, Math.ceil(bytes)), this.budget);
    if (this.waiting.length == 0 && this.used + weight <= this.budget) {
      this.used += weight;
      return this.releaser(weight);
    }
    if (this.waiting.length >= this.maxWaiting) {
      throw new ConatError(
        "persist server is busy replaying streams; try again",
        { code: 503 },
      );
    }
    await new Promise<void>((resolve, reject) => {
      const entry = {
        weight,
        admit: () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        const i = this.waiting.indexOf(entry);
        if (i >= 0) this.waiting.splice(i, 1);
        // a large page leaving the head of the queue may let others in
        this.drain();
        reject(signal.reason ?? new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(entry);
    });
    // drain() already counted this weight as used
    return this.releaser(weight);
  };

  stats = () => ({ used: this.used, waiting: this.waiting.length });

  private drain = () => {
    while (
      this.waiting.length > 0 &&
      this.used + this.waiting[0].weight <= this.budget
    ) {
      const next = this.waiting.shift()!;
      this.used += next.weight;
      next.admit();
    }
  };

  private releaser = (weight: number): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= weight;
      this.drain();
    };
  };
}

let replayAdmission = new ReplayAdmission(
  REPLAY_BUDGET_BYTES,
  MAX_WAITING_REPLAY_PAGES,
);

// for unit tests
export function resetReplayAdmission(
  budget = REPLAY_BUDGET_BYTES,
  maxWaiting = MAX_WAITING_REPLAY_PAGES,
): ReplayAdmission {
  replayAdmission = new ReplayAdmission(budget, maxWaiting);
  return replayAdmission;
}

// Replay a stream for a getAll request.  Errors propagate to the request
// handler, which sends a small error-only response.  Stops quietly once signal
// aborts (the socket closed).
//
// Where it ends: at the newest message that existed when it started (or
// request.end_seq, if lower).  When a changefeed is active for the connection
// that is the end: the changefeed delivers everything after, so going further
// would deliver those messages twice, and a stream under constant writes could
// keep the replay chasing its tail.  Without a changefeed it makes one more
// pass up to the newest message at the end of the first pass, so a message
// rewritten under the same key meanwhile is still included, and then stops.
export async function replay({
  stream,
  mesg,
  request,
  messagesThresh,
  signal = new AbortController().signal,
  changefeedActive = false,
}: {
  stream: PersistentStream;
  mesg;
  request;
  messagesThresh: number;
  signal?: AbortSignal;
  changefeedActive?: boolean;
}): Promise<void> {
  let seq = 0;
  let sentConfig = false;
  let sentMetadata = false;
  let sentCheckpoints = false;
  let sentReplayInfo = false;
  const config = request.includeConfig ? stream.config() : undefined;
  const metadata = request.includeMetadata ? stream.getMetadata() : undefined;
  const checkpoints = request.includeCheckpoints
    ? stream.getCheckpoints()
    : undefined;
  const checkpointSeq =
    request.start_checkpoint != null
      ? stream.getCheckpoint(request.start_checkpoint)?.seq
      : undefined;
  const startSeq =
    request.start_seq == null
      ? checkpointSeq
      : checkpointSeq == null
        ? request.start_seq
        : Math.max(request.start_seq, checkpointSeq);
  const { oldest_retained_seq, newest_retained_seq } = stream.seqBounds();
  const effective_start_seq =
    startSeq == null
      ? oldest_retained_seq
      : oldest_retained_seq == null
        ? startSeq
        : Math.max(startSeq, oldest_retained_seq);
  let lastSentAt = Date.now();
  const respond = (messages?: StoredMessage[]) => {
    const headers = {
      seq,
      config: !sentConfig ? config : undefined,
      metadata: !sentMetadata ? metadata : undefined,
      checkpoints: !sentCheckpoints ? checkpoints : undefined,
      effective_start_seq: !sentReplayInfo ? effective_start_seq : undefined,
      oldest_retained_seq: !sentReplayInfo ? oldest_retained_seq : undefined,
      newest_retained_seq: !sentReplayInfo ? newest_retained_seq : undefined,
      instance: !sentReplayInfo ? stream.instance : undefined,
    };
    // Only these fixed envelope fields are enumerated. Mirror JSON's omission
    // of undefined values, then validate before the unconfirmed publication so
    // rejection cannot be followed by success with the bootstrap fields gone.
    for (const key of Object.keys(headers)) {
      if (headers[key] === undefined) delete headers[key];
    }
    validateMessageHeaders(headers);
    mesg.respondSync(messages, { headers });
    sentConfig = true;
    sentMetadata = true;
    sentCheckpoints = true;
    sentReplayInfo = true;
    seq += 1;
    lastSentAt = Date.now();
  };

  const endAt = (newest: number | undefined): number =>
    Math.min(newest ?? 0, request.end_seq ?? Number.MAX_SAFE_INTEGER);
  let end = endAt(newest_retained_seq);
  let extend = !changefeedActive;

  // An empty frame is a valid partial response for every client version.
  const keepaliveMs = replayKeepaliveMs(request.timeout);
  const keepalive = setInterval(
    () => {
      if (!signal.aborted && Date.now() - lastSentAt >= keepaliveMs) {
        respond([]);
      }
    },
    // checking 4x as often keeps the longest gap near keepaliveMs
    Math.max(25, Math.floor(keepaliveMs / 4)),
  );
  keepalive.unref?.();
  try {
    const sizeLimit = maxPersistMessageBytes();
    const messages: StoredMessage[] = [];
    let size = 0;
    let after_seq = startSeq == null ? 0 : startSeq - 1;
    while (true) {
      if (signal.aborted) return;
      if (stream.isClosing()) {
        throw new ConatError("stream closed during replay", { code: 503 });
      }
      const plan = stream.planPage({
        after_seq,
        end_seq: end,
        maxRows: REPLAY_PAGE_ROWS,
        maxBytes: REPLAY_PAGE_BYTES,
      });
      if (plan.length == 0) {
        if (extend) {
          extend = false;
          const next = endAt(stream.seqBounds().newest_retained_seq);
          if (next > end) {
            end = next;
            continue;
          }
        }
        break;
      }
      const oversized = plan.find((row) => row.size > sizeLimit);
      if (oversized != null) {
        // refuse before reading or decompressing it
        throw persistMessageTooLargeError({
          size: oversized.size,
          limit: sizeLimit,
          seq: oversized.seq,
        });
      }
      const last_seq = plan[plan.length - 1].seq;
      const pageBytes = plan.reduce(
        (total, row) => total + Math.max(row.size, REPLAY_MESSAGE_CHARGE_BYTES),
        0,
      );
      const heavy = plan.some((row) => row.size >= ASYNC_DECOMPRESS_MIN_BYTES);
      let release: () => void;
      try {
        release = await replayAdmission.acquire(
          heavy ? Math.max(pageBytes, replayAdmission.budget / 2) : pageBytes,
          signal,
        );
      } catch (err) {
        if (signal.aborted) return;
        throw err;
      }
      try {
        if (signal.aborted) return;
        for (const row of stream.readPage(after_seq, last_seq)) {
          const message = await storedRowToMessage(row);
          if (signal.aborted) return;
          messages.push(message);
          size += message.raw.length;
          if (size >= messagesThresh) {
            respond(messages);
            messages.length = 0;
            size = 0;
          }
        }
        // send the page before releasing its admission, so the budget bounds
        // what replays hold
        if (messages.length > 0) {
          respond(messages);
          messages.length = 0;
          size = 0;
        }
      } finally {
        release();
      }
      after_seq = last_seq;
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (signal.aborted) return;
    if (messages.length > 0) {
      respond(messages);
    }
    // successful finish
    respond();
  } finally {
    clearInterval(keepalive);
  }
}

function startChangefeed({ socket, stream, messagesThresh }) {
  logger.debug("startChangefeed", { subject: socket.subject });
  // this seq here has nothing to do with the seq of the StoredMessage!
  let seq = 0;
  const respond = (error?, messages?: ChangefeedOperation[]) => {
    if (socket.state == "closed") {
      return;
    }
    //logger.debug("changefeed: writing messages to socket", { seq, messages });
    socket.write(messages, { headers: { error, seq } });
    seq += 1;
  };

  const unsentMessages: ChangefeedOperation[] = [];
  const sendAllUnsentMessages = throttle(
    () => {
      while (socket.state != "closed" && unsentMessages.length > 0) {
        const messages: ChangefeedOperation[] = [];
        let size = 0;
        while (unsentMessages.length > 0 && socket.state != "closed") {
          const message = unsentMessages.shift();
          // e.g. op:'delete' messages have length 0 and no raw field
          if (message != null && "raw" in message) {
            size += message.raw?.length ?? 0;
          }
          messages.push(message!);
          if (size >= messagesThresh) {
            respond(undefined, messages);
            size = 0;
            messages.length = 0;
          }
        }
        if (messages.length > 0) {
          respond(undefined, messages);
        }
      }
    },
    SEND_THROTTLE,
    { leading: true, trailing: true },
  );

  const onChange = (message) => {
    if (socket.state == "closed") {
      return;
    }
    //console.log("stream change event", message);
    // logger.debug("changefeed got message", message, socket.state);
    unsentMessages.push(message);
    sendAllUnsentMessages();
  };
  stream.on("change", onChange);
  // The stream is shared by every socket on this subject and can stay open
  // for days while one of them does; a listener left behind by a closed
  // socket would keep that socket, and anything it queued, until then.
  return () => {
    stream.removeListener("change", onChange);
    sendAllUnsentMessages.cancel();
    unsentMessages.length = 0;
  };
}
