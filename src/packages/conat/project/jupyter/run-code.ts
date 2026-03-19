/*
Tests are in

packages/backend/conat/test/juypter/run-code.test.s

*/

import { type Client as ConatClient } from "@cocalc/conat/core/client";
import {
  type ConatSocketServer,
  type ServerSocket,
} from "@cocalc/conat/socket";
import { EventIterator } from "@cocalc/util/event-iterator";
import { getLogger } from "@cocalc/conat/client";
import { Throttle } from "@cocalc/util/throttle";
import {
  jupyterLiveRunKey,
  openJupyterLiveRunStore,
  jupyterLiveRunSubject,
  type JupyterLiveRunBatch,
  type JupyterLiveRunSnapshot,
} from "@cocalc/conat/project/jupyter/live-run";
const MAX_MSGS_PER_SECOND = parseInt(
  process.env.COCALC_JUPYTER_MAX_MSGS_PER_SECOND ?? "20",
);
const SOCKET_KEEP_ALIVE = parsePositiveInt(
  process.env.COCALC_JUPYTER_SOCKET_KEEP_ALIVE,
  25_000,
);
const SOCKET_KEEP_ALIVE_TIMEOUT = parsePositiveInt(
  process.env.COCALC_JUPYTER_SOCKET_KEEP_ALIVE_TIMEOUT,
  10_000,
);
const logger = getLogger("conat:project:jupyter:run-code");
const LIVE_RUN_REPLAY_GRACE_MS = 60_000;

function getSubject({ project_id }: { project_id: string }) {
  return `jupyter.project-${project_id}.0`;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? "", 10);
  if (Number.isFinite(n) && n > 0) {
    return n;
  }
  return fallback;
}

let runIdCounter = 0;
function nextRunId(): string {
  runIdCounter += 1;
  return `run-${Date.now().toString(36)}-${runIdCounter.toString(36)}`;
}

export interface InputCell {
  id: string;
  input: string;
  output?: { [n: string]: OutputMessage | null } | null;
  state?: "done" | "busy" | "run";
  exec_count?: number | null;
  start?: number | null;
  end?: number | null;
  cell_type?: "code";
}

export interface OutputMessage {
  // id = id of the cell
  id?: string;
  // application-level run id for dropping stale messages.
  run_id?: string;
  // explicit lifecycle marker used by frontend/backend handlers.
  lifecycle?: LifecycleMessageType;
  // everything below is exactly from Jupyter
  metadata?;
  content?;
  buffers?;
  msg_type?: string;
  done?: boolean;
  more_output?: boolean;
}

export type LifecycleMessageType =
  | "run_start"
  | "run_done"
  | "cell_start"
  | "cell_done";

const LIFECYCLE_MSG_TYPES = new Set<LifecycleMessageType>([
  "run_start",
  "run_done",
  "cell_start",
  "cell_done",
]);

function getLifecycleType(
  mesg: OutputMessage | undefined,
): LifecycleMessageType | null {
  const lifecycle = mesg?.lifecycle;
  if (
    typeof lifecycle === "string" &&
    LIFECYCLE_MSG_TYPES.has(lifecycle as any)
  ) {
    return lifecycle as LifecycleMessageType;
  }
  const msg_type = mesg?.msg_type;
  if (
    typeof msg_type === "string" &&
    LIFECYCLE_MSG_TYPES.has(msg_type as any)
  ) {
    return msg_type as LifecycleMessageType;
  }
  return null;
}

function isLifecycleMessage(mesg: OutputMessage | undefined): boolean {
  return getLifecycleType(mesg) != null;
}

function normalizeOutputMessage(
  mesg: OutputMessage,
  run_id: string,
): OutputMessage {
  const normalized: OutputMessage =
    mesg.run_id === run_id ? mesg : { ...mesg, run_id };
  const lifecycle = getLifecycleType(normalized);
  if (lifecycle == null) {
    return normalized;
  }
  if (normalized.lifecycle === lifecycle && normalized.msg_type === lifecycle) {
    return normalized;
  }
  return { ...normalized, lifecycle, msg_type: lifecycle };
}

function isCoalescableStreamMessage(mesg: OutputMessage | undefined): boolean {
  if (mesg == null || mesg.msg_type !== "stream") return false;
  if (isLifecycleMessage(mesg)) return false;
  if (mesg.more_output || mesg.done) return false;
  if (typeof mesg.id !== "string") return false;
  if (mesg.buffers != null && mesg.buffers.length > 0) return false;
  const content = mesg.content;
  if (content == null || typeof content !== "object") return false;
  if (typeof content.name !== "string") return false;
  if (typeof content.text !== "string") return false;
  return true;
}

function cloneOutputMessage(mesg: OutputMessage): OutputMessage {
  const content =
    mesg.content != null && typeof mesg.content === "object"
      ? { ...mesg.content }
      : mesg.content;
  const metadata =
    mesg.metadata != null && typeof mesg.metadata === "object"
      ? { ...mesg.metadata }
      : mesg.metadata;
  return {
    ...mesg,
    content,
    metadata,
    buffers: Array.isArray(mesg.buffers) ? [...mesg.buffers] : mesg.buffers,
  };
}

function appendOutputMessage(
  output: OutputMessage[],
  mesg: OutputMessage,
): boolean {
  const prev = output[output.length - 1];
  if (
    isCoalescableStreamMessage(prev) &&
    isCoalescableStreamMessage(mesg) &&
    prev.run_id === mesg.run_id &&
    prev.id === mesg.id &&
    prev.content.name === mesg.content.name
  ) {
    prev.content.text += mesg.content.text;
    return false;
  }
  output.push(cloneOutputMessage(mesg));
  return true;
}

function coalesceOutputBatch(mesgs: OutputMessage[]): OutputMessage[] {
  const output: OutputMessage[] = [];
  for (const mesg of mesgs) {
    appendOutputMessage(output, mesg);
  }
  return output;
}

export interface RunOptions {
  // syncdb path
  path: string;
  // array of input cells to run
  cells: InputCell[];
  // application-level id used for cross-layer timing correlation
  run_id?: string;
  // if true do not halt running the cells, even if one fails with an error
  noHalt?: boolean;
  // the socket is used for raw_input, to communicate between the client
  // that initiated the request and the server.
  socket: ServerSocket;
}

type JupyterCodeRunner = (
  opts: RunOptions,
) => Promise<AsyncGenerator<OutputMessage, void, unknown>>;

interface OutputHandler {
  process: (mesg: OutputMessage) => void;
  done: () => void;
}

type CreateOutputHandler = (opts: {
  path: string;
  cells: InputCell[];
}) => OutputHandler;

export function jupyterServer({
  client,
  project_id,
  // run takes a path and cells to run and returns an async iterator
  // over the outputs.
  run,
  // outputHandler takes a path and returns an OutputHandler, which can be
  // used to process the output and include it in the notebook.  It is used
  // as a fallback in case the client that initiated running cells is
  // disconnected, so output won't be lost.
  outputHandler,
  mirrorOutputHandler = false,
  getKernelStatus,
}: {
  client: ConatClient;
  project_id: string;
  run: JupyterCodeRunner;
  outputHandler?: CreateOutputHandler;
  mirrorOutputHandler?: boolean;
  getKernelStatus: (opts: { path: string }) => Promise<{
    backend_state:
      | "failed"
      | "off"
      | "spawning"
      | "starting"
      | "running"
      | "closed";
    kernel_state: "idle" | "busy" | "running";
  }>;
}) {
  const subject = getSubject({ project_id });
  const server: ConatSocketServer = client.socket.listen(subject, {
    keepAlive: SOCKET_KEEP_ALIVE,
    keepAliveTimeout: SOCKET_KEEP_ALIVE_TIMEOUT,
  });
  logger.debug("server: listening on ", { subject });
  const moreOutput: { [path: string]: { [id: string]: any[] } } = {};

  server.on("connection", (socket: ServerSocket) => {
    logger.debug("server: got new connection", {
      id: socket.id,
      subject: socket.subject,
    });

    socket.on("request", async (mesg) => {
      const { data } = mesg;
      const { cmd, path } = data;
      if (cmd == "more") {
        logger.debug("more output ", { id: data.id });
        mesg.respondSync(moreOutput[path]?.[data.id]);
      } else if (cmd == "get-kernel-status") {
        mesg.respondSync(await getKernelStatus({ path }));
      } else if (cmd == "run") {
        const { cells, noHalt, limit } = data;
        const run_id =
          typeof data.run_id == "string" ? data.run_id : nextRunId();
        try {
          mesg.respondSync(null);
          if (moreOutput[path] == null) {
            moreOutput[path] = {};
          }
          logger.debug("run request", {
            run_id,
            path,
            cells: cells?.length,
            limit,
            noHalt,
            socket_id: socket.id,
          });
          await handleRequest({
            client,
            project_id,
            run_id,
            socket,
            run,
            outputHandler,
            mirrorOutputHandler,
            path,
            cells,
            noHalt,
            limit,
            moreOutput: moreOutput[path],
          });
        } catch (err) {
          logger.debug("server: failed to handle execute request -- ", err);
          if (socket.state != "closed") {
            try {
              logger.debug("sending to client: ", {
                headers: { error: `${err}` },
              });
              socket.write(null, { headers: { foo: "bar", error: `${err}` } });
            } catch (err) {
              // an error trying to report an error shouldn't crash everything
              logger.debug("WARNING: unable to send error to client", err);
            }
          }
        }
      } else {
        const error = `Unknown command '${cmd}'`;
        logger.debug(error);
        mesg.respondSync(null, { headers: { error } });
      }
    });

    socket.on("closed", () => {
      logger.debug("socket closed", { id: socket.id });
    });
  });

  return server;
}

async function handleRequest({
  client,
  project_id,
  run_id,
  socket,
  run,
  outputHandler,
  mirrorOutputHandler,
  path,
  cells,
  noHalt,
  limit,
  moreOutput,
}) {
  const startedAt = Date.now();
  let firstMesgAt: number | null = null;
  let totalMesgs = 0;
  let totalBatches = 0;
  let enobufs = 0;
  let fallbackActivated = false;
  let fallbackReplayed = 0;
  let fallbackProcessed = 0;
  let moreOutputBuffered = 0;
  let summaryError: string | undefined;
  let firstClientBatchFastLane = false;
  let socketClosedDuringRun = false;
  const liveRunSubject = jupyterLiveRunSubject({ project_id, path });
  const liveRunStore = await openJupyterLiveRunStore({ client, project_id });
  const liveRunKey = jupyterLiveRunKey({ path, run_id });
  const runner = await run({ path, cells, noHalt, socket, run_id });
  const output: OutputMessage[] = [];
  let outputVisibleCount = 0;
  let batchSeq = 0;
  let liveRunSnapshot: JupyterLiveRunSnapshot = {
    path,
    run_id,
    batches: [],
    updated_at_ms: Date.now(),
  };
  for (const cell of cells) {
    moreOutput[cell.id] = [];
  }
  liveRunStore.set(liveRunKey, liveRunSnapshot);
  logger.debug(
    `handleRequest to evaluate ${cells.length} cells with limit=${limit} for path=${path}`,
  );

  const throttle = new Throttle<OutputMessage>(MAX_MSGS_PER_SECOND);
  let unhandledClientWriteError: any = undefined;
  let writeQueue: Promise<void> = Promise.resolve();
  let livePublishQueue: Promise<void> = Promise.resolve();
  const writeLiveRunSnapshot = (opts?: { done?: boolean }) => {
    liveRunSnapshot = {
      ...liveRunSnapshot,
      updated_at_ms: Date.now(),
      done: opts?.done ?? liveRunSnapshot.done,
    };
    liveRunStore.set(liveRunKey, liveRunSnapshot);
  };
  const publishLiveBatch = (mesgs: OutputMessage[]) => {
    if (mesgs.length == 0) {
      return;
    }
    const batch: JupyterLiveRunBatch = {
      path,
      run_id,
      seq: ++batchSeq,
      id: `${run_id}:${batchSeq}`,
      mesgs,
      sent_at_ms: Date.now(),
    };
    liveRunSnapshot = {
      ...liveRunSnapshot,
      batches: [...liveRunSnapshot.batches, batch],
      updated_at_ms: batch.sent_at_ms,
      done: false,
    };
    liveRunStore.set(liveRunKey, liveRunSnapshot);
    livePublishQueue = livePublishQueue.then(async () => {
      await client.publish(liveRunSubject, batch);
    });
    return livePublishQueue;
  };
  const writeBatchToClient = async (
    mesgs: OutputMessage[],
    opts?: { fastLane?: boolean },
  ) => {
    if (mesgs.length == 0) {
      return;
    }
    totalBatches += 1;
    const coalescedMesgs = coalesceOutputBatch(mesgs);
    void publishLiveBatch(coalescedMesgs);
    if (socket.state == "closed") {
      return;
    }
    try {
      socket.write(coalescedMesgs);
      if (opts?.fastLane) {
        firstClientBatchFastLane = true;
      }
    } catch (err) {
      if (err.code == "ENOBUFS") {
        enobufs += 1;
        // wait for the over-filled socket to finish writing out data.
        await socket.drain();
        socket.write(coalescedMesgs);
        if (opts?.fastLane) {
          firstClientBatchFastLane = true;
        }
      } else {
        unhandledClientWriteError = err;
      }
    }
  };
  const enqueueWriteBatch = (
    mesgs: OutputMessage[],
    opts?: { fastLane?: boolean },
  ) => {
    writeQueue = writeQueue.then(async () => {
      await writeBatchToClient(mesgs, opts);
    });
    return writeQueue;
  };
  throttle.on("data", (mesgs) => {
    void enqueueWriteBatch(mesgs);
  });
  const handleVisibleMesg = async (mesg: OutputMessage) => {
    if (socket.state != "closed" && unhandledClientWriteError) {
      throw unhandledClientWriteError;
    }
    const wasAppended = appendOutputMessage(output, mesg);
    if (isLifecycleMessage(mesg)) {
      const lifecycle = getLifecycleType(mesg);
      if (lifecycle == "cell_done" || lifecycle == "run_done") {
        // Keep completion lifecycle in the same throttled stream as output
        // so done events cannot overtake buffered output.
        throttle.write(mesg);
        return;
      }
      await enqueueWriteBatch([mesg], { fastLane: totalBatches == 0 });
      return;
    }
    if (wasAppended) {
      outputVisibleCount += 1;
    }
    if (typeof mesg.id != "string") {
      return;
    }
    if (limit == null || outputVisibleCount < limit) {
      if (totalBatches == 0) {
        // Fast-lane the very first output batch for lower latency.
        // We keep existing throttling for all subsequent output.
        await enqueueWriteBatch([mesg], { fastLane: true });
      } else {
        throttle.write(mesg);
      }
    } else {
      if (outputVisibleCount == limit) {
        throttle.write({
          id: mesg.id,
          run_id,
          more_output: true,
        });
        moreOutput[mesg.id] = [];
      }
      if (moreOutput[mesg.id] == null) {
        moreOutput[mesg.id] = [];
      }
      appendOutputMessage(moreOutput[mesg.id], mesg);
      moreOutputBuffered += 1;
    }
  };

  try {
    let backendHandler: OutputHandler | null = null;
    let outputProcess: ((mesg: OutputMessage) => void) | null = null;
    const ensureHandler = () => {
      if (backendHandler != null && outputProcess != null) {
        return;
      }
      if (outputHandler == null) {
        throw Error("no output handler available");
      }
      backendHandler = outputHandler({ path, cells });
      if (backendHandler == null) {
        throw Error("bug -- outputHandler must return a handler");
      }
      outputProcess = (mesg) => {
        if (backendHandler == null) return;
        const lifecycle = getLifecycleType(mesg);
        if (lifecycle != null) {
          if (lifecycle == "cell_start" && typeof mesg.id == "string") {
            backendHandler.process({
              id: mesg.id,
              content: { execution_state: "busy" },
            });
          } else if (lifecycle == "cell_done" && typeof mesg.id == "string") {
            backendHandler.process({ id: mesg.id, done: true });
          }
          fallbackProcessed += 1;
          return;
        }
        if (typeof mesg.id != "string") {
          fallbackProcessed += 1;
          return;
        }
        backendHandler.process(mesg);
        fallbackProcessed += 1;
      };
    };

    if (mirrorOutputHandler && outputHandler != null) {
      ensureHandler();
    }

    for await (const mesg0 of runner) {
      const mesg = normalizeOutputMessage(mesg0, run_id);
      totalMesgs += 1;
      if (firstMesgAt == null) {
        firstMesgAt = Date.now();
      }
      if (socket.state == "closed") {
        socketClosedDuringRun = true;
        // client socket has closed -- the backend server must take over!
        if (backendHandler == null || outputProcess == null) {
          fallbackActivated = true;
          logger.debug("socket closed -- server must handle output");
          ensureHandler();
          fallbackReplayed += output.length;
          for (const prev of output) {
            outputProcess!(prev);
          }
          output.length = 0;
        }
      }
      const activeProcess = outputProcess as
        | ((mesg: OutputMessage) => void)
        | null;
      if (
        activeProcess != null &&
        (mirrorOutputHandler || socket.state == "closed")
      ) {
        activeProcess(mesg);
      }
      await handleVisibleMesg(mesg);
    }
    // no errors happened, so close up and flush and
    // remaining data immediately:
    const activeHandler = backendHandler as OutputHandler | null;
    activeHandler?.done();
    throttle.flush();
    await writeQueue;
    await livePublishQueue;
    writeLiveRunSnapshot({ done: true });
    if (socket.state != "closed") {
      socket.write(null);
    }
  } catch (err) {
    summaryError = `${err}`;
    writeLiveRunSnapshot({ done: true });
    throw err;
  } finally {
    throttle.close();
    setTimeout(() => {
      try {
        liveRunStore.delete(liveRunKey);
      } catch {
        // ignore cleanup failures for ephemeral replay state
      }
    }, LIVE_RUN_REPLAY_GRACE_MS);
    logger.debug("run summary", {
      run_id,
      path,
      cells: cells.length,
      limit: limit ?? null,
      duration_ms: Date.now() - startedAt,
      first_message_ms:
        firstMesgAt == null ? null : Math.max(0, firstMesgAt - startedAt),
      total_messages: totalMesgs,
      total_batches: totalBatches,
      more_output_buffered: moreOutputBuffered,
      first_batch_fast_lane: firstClientBatchFastLane,
      fallback_activated: fallbackActivated || socketClosedDuringRun,
      fallback_replayed: fallbackReplayed,
      fallback_processed: fallbackProcessed,
      enobufs,
      socket_state: socket.state,
      error: summaryError,
    });
  }
}

export class JupyterClient {
  private iter?: EventIterator<OutputMessage[]>;
  public readonly socket;
  constructor(
    private client: ConatClient,
    private subject: string,
    private path: string,
    private stdin: (opts: {
      id: string;
      prompt: string;
      password?: boolean;
    }) => Promise<string>,
  ) {
    this.socket = this.client.socket.connect(this.subject);
    this.socket.once("close", () => this.iter?.end());
    this.socket.on("request", async (mesg) => {
      const { data } = mesg;
      try {
        switch (data.type) {
          case "stdin":
            await mesg.respond(await this.stdin(data));
            return;
          default:
            console.warn(`Jupyter: got unknown message type '${data.type}'`);
            await mesg.respond(
              new Error(`unknown message type '${data.type}'`),
            );
        }
      } catch (err) {
        console.warn("error responding to jupyter request", err);
      }
    });
  }

  close = () => {
    try {
      this.iter?.end();
      delete this.iter;
      this.socket.close();
    } catch {}
  };

  moreOutput = async (id: string) => {
    const { data } = await this.socket.request({
      cmd: "more",
      path: this.path,
      id,
    });
    return data;
  };

  getKernelStatus = async () => {
    const { data } = await this.socket.request({
      cmd: "get-kernel-status",
      path: this.path,
    });
    return data;
  };

  run = (
    cells: InputCell[],
    opts: {
      noHalt?: boolean;
      limit?: number;
      run_id?: string;
      waitForAck?: boolean;
    } = {},
  ) => {
    const effectiveRunId = opts.run_id ?? nextRunId();
    if (this.iter) {
      // one evaluation at a time -- starting a new one ends the previous one.
      // Each client browser has a separate instance of JupyterClient, so
      // a properly implemented frontend client would never hit this.
      this.iter.end();
      delete this.iter;
    }
    const iter = new EventIterator<OutputMessage[]>(this.socket, "data", {
      map: (args) => {
        if (args[1]?.error) {
          iter.throw(Error(args[1].error));
          return [];
        }
        if (args[0] == null) {
          iter.end();
          return [];
        } else {
          const batch = args[0];
          const filtered = Array.isArray(batch)
            ? batch.filter((mesg) => mesg?.run_id === effectiveRunId)
            : [];
          if (filtered.length == 0) {
            return [];
          }
          return filtered;
        }
      },
    });
    this.iter = iter;
    // get rid of any fields except id and input from the cells, since, e.g.,
    // if there is a lot of output in a cell, there is no need to send that to the backend.
    const cells1 = cells.map(({ id, input }) => {
      return { id, input };
    });
    const { waitForAck = true, ...requestOpts0 } = opts;
    const requestOpts = {
      ...requestOpts0,
      run_id: effectiveRunId,
    };
    const request = this.socket.request({
      cmd: "run",
      ...requestOpts,
      path: this.path,
      cells: cells1,
    });
    if (waitForAck) {
      return request.then(() => iter);
    }
    // Important latency optimization: optionally don't wait for the
    // request/response ack before returning the iterator. This lets the caller
    // start consuming output immediately and can remove one RTT from the
    // critical path.
    void request.catch((err) => {
      if (this.iter === iter && !iter.ended) {
        iter.throw(err);
      }
    });
    return Promise.resolve(iter);
  };
}

export function jupyterClient(opts: {
  path: string;
  project_id: string;
  client: ConatClient;
  stdin?: (opts: {
    id: string;
    prompt: string;
    password?: boolean;
  }) => Promise<string>;
}): JupyterClient {
  const subject = getSubject(opts);
  return new JupyterClient(
    opts.client,
    subject,
    opts.path,
    opts.stdin ?? (async () => "stdin not implemented"),
  );
}
