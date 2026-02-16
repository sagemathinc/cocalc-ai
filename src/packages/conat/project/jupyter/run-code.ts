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
  id: string;
  // everything below is exactly from Jupyter
  metadata?;
  content?;
  buffers?;
  msg_type?: string;
  done?: boolean;
  more_output?: boolean;
}

function isCoalescableStreamMessage(mesg: OutputMessage | undefined): boolean {
  if (mesg == null || mesg.msg_type !== "stream") return false;
  if (mesg.more_output || mesg.done) return false;
  if (typeof mesg.id !== "string") return false;
  if (mesg.buffers != null && mesg.buffers.length > 0) return false;
  const content = mesg.content;
  if (content == null || typeof content !== "object") return false;
  if (typeof content.name !== "string") return false;
  if (typeof content.text !== "string") return false;
  return true;
}

function appendOutputMessage(
  output: OutputMessage[],
  mesg: OutputMessage,
): boolean {
  const prev = output[output.length - 1];
  if (
    isCoalescableStreamMessage(prev) &&
    isCoalescableStreamMessage(mesg) &&
    prev.id === mesg.id &&
    prev.content.name === mesg.content.name
  ) {
    prev.content.text += mesg.content.text;
    return false;
  }
  output.push(mesg);
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
  getKernelStatus,
}: {
  client: ConatClient;
  project_id: string;
  run: JupyterCodeRunner;
  outputHandler?: CreateOutputHandler;
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
            run_id,
            socket,
            run,
            outputHandler,
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
  run_id,
  socket,
  run,
  outputHandler,
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
  const runner = await run({ path, cells, noHalt, socket, run_id });
  const output: OutputMessage[] = [];
  for (const cell of cells) {
    moreOutput[cell.id] = [];
  }
  logger.debug(
    `handleRequest to evaluate ${cells.length} cells with limit=${limit} for path=${path}`,
  );

  const throttle = new Throttle<OutputMessage>(MAX_MSGS_PER_SECOND);
  let unhandledClientWriteError: any = undefined;
  throttle.on("data", async (mesgs) => {
    totalBatches += 1;
    const coalescedMesgs = coalesceOutputBatch(mesgs);
    try {
      socket.write(coalescedMesgs);
    } catch (err) {
      if (err.code == "ENOBUFS") {
        enobufs += 1;
        // wait for the over-filled socket to finish writing out data.
        await socket.drain();
        socket.write(coalescedMesgs);
      } else {
        unhandledClientWriteError = err;
      }
    }
  });

  try {
    let handler: OutputHandler | null = null;
    let process: ((mesg: any) => void) | null = null;
    let fallbackOutputCount = 0;
    let fallbackMoreOutputMode = false;

    for await (const mesg of runner) {
      totalMesgs += 1;
      if (firstMesgAt == null) {
        firstMesgAt = Date.now();
      }
      if (socket.state == "closed") {
        // client socket has closed -- the backend server must take over!
        if (handler == null || process == null) {
          fallbackActivated = true;
          logger.debug("socket closed -- server must handle output");
          if (outputHandler == null) {
            throw Error("no output handler available");
          }
          handler = outputHandler({ path, cells });
          if (handler == null) {
            throw Error("bug -- outputHandler must return a handler");
          }
          process = (mesg) => {
            if (handler == null) return;
            // Replay must enforce the output limit based on how many messages
            // we have replayed so far, not the final size of the pre-close
            // output buffer.
            const replayedCount = fallbackOutputCount + 1;
            if (limit == null || replayedCount < limit) {
              handler.process(mesg);
            } else {
              if (!fallbackMoreOutputMode) {
                handler.process({ id: mesg.id, more_output: true });
                moreOutput[mesg.id] = [];
                fallbackMoreOutputMode = true;
              }
              appendOutputMessage(moreOutput[mesg.id], mesg);
              moreOutputBuffered += 1;
            }
            fallbackOutputCount += 1;
            fallbackProcessed += 1;
          };

          fallbackReplayed += output.length;
          for (const prev of output) {
            process(prev);
          }
          output.length = 0;
        }
        process(mesg);
      } else {
        if (unhandledClientWriteError) {
          throw unhandledClientWriteError;
        }
        appendOutputMessage(output, mesg);
        if (limit == null || output.length < limit) {
          throttle.write(mesg);
        } else {
          if (output.length == limit) {
            throttle.write({
              id: mesg.id,
              more_output: true,
            });
            moreOutput[mesg.id] = [];
          }
          // save the more output
          appendOutputMessage(moreOutput[mesg.id], mesg);
          moreOutputBuffered += 1;
        }
      }
    }
    // no errors happened, so close up and flush and
    // remaining data immediately:
    handler?.done();
    if (socket.state != "closed") {
      throttle.flush();
      socket.write(null);
    }
  } catch (err) {
    summaryError = `${err}`;
    throw err;
  } finally {
    throttle.close();
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
      fallback_activated: fallbackActivated,
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
          return;
        }
        if (args[0] == null) {
          iter.end();
          return;
        } else {
          return args[0];
        }
      },
    });
    this.iter = iter;
    // get rid of any fields except id and input from the cells, since, e.g.,
    // if there is a lot of output in a cell, there is no need to send that to the backend.
    const cells1 = cells.map(({ id, input }) => {
      return { id, input };
    });
    const { waitForAck = true, ...requestOpts } = opts;
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
