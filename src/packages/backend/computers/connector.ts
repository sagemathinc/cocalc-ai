/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The computer's side of CoCalc (`cocalc computer connect`): pair with an
// account, then serve the one project it is attached to.
// Design: src/.agents/computers-direct-host-2026-10-16.md.
//
// - Pairing (the account's home bay): claim the request, show the phrase,
//   wait for the owner's approval. The secret the claim returned becomes
//   this computer's token.
// - Serving: ask the home bay for a short-lived token for the project's
//   host, connect to that host directly (like a browser), and answer exec
//   and hello requests from the project. Commands never pass through the
//   hub. Before the host token expires, connect again, then close the old
//   connection; answers always go back on the newest one.
// - Revoked: the home bay says so when asked for a token. Every running
//   command is stopped and the connector ends for good.
// - A command runs only while the computer stays connected: an unplanned
//   drop stops every running command. Delivery is at most once; the asker
//   gets an error and decides whether to retry.
//
// Files (owner-only, under ~/.local/share/cocalc/computers/<computer_id>):
//   connection.json  site, computer id, name, project, and the token

import { hostname, homedir, userInfo } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { isValidUUID } from "@cocalc/util/misc";
import {
  HOST_TOKEN_REFRESH_MS,
  type HostConnection,
  type PairingClaim,
} from "@cocalc/util/computers/api";
import {
  OperationError,
  parseExecRequest,
} from "@cocalc/util/computers/operations";
import {
  computerExecSubject,
  computerHelloSubject,
  type ComputerExecReply,
  type ComputerHello,
} from "@cocalc/conat/computers/subjects";
import { connect, type Client } from "@cocalc/conat/core/client";
import { REPLY_HEADER } from "@cocalc/conat/core/message-headers";
import type { ReceiveLimits } from "@cocalc/conat/core/receive-budget";
import { ensurePrivateDir, readJson, writeDurableJson } from "./durable";
import { runExec } from "./exec";

/**
 * Raw limits on what a request may be, enforced before reassembly: an exec
 * request is a command (32 KB) and at most 1 MiB of stdin, base64.
 */
export const REQUEST_RECEIVE_LIMITS: ReceiveLimits = {
  maxMessageBytes: 4 * 1024 * 1024,
  maxInflightBytes: 16 * 1024 * 1024,
  maxInflightMessages: 16,
  maxFragmentsPerMessage: 64,
};

/** Commands running here at once; more are refused. */
export const MAX_RUNNING = 16;

export interface ConnectorIO {
  log(message: string): void;
  /** Ask the person at the machine; false if nobody can answer. */
  confirm(question: string): Promise<boolean>;
}

export interface Connection {
  dir: string;
  origin: string;
  computer_id: string;
  name: string;
  project_id: string;
  token: string;
}

/** Where computers keep their files (XDG data dir). */
export function computersDir(): string {
  const base =
    process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(base, "cocalc", "computers");
}

/** `https://site/c/R-XXXXXXXXXX` -> its origin and request id. */
export function parsePairingUrl(url: string): {
  origin: string;
  request_id: string;
} {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(
      "give the line CoCalc showed you, like https://cocalc.ai/c/R-...",
    );
  }
  const m = u.pathname.match(/^\/c\/(R-[0-9A-HJ-NP-Z]{10})\/?$/);
  if (m == null || (u.protocol !== "https:" && u.protocol !== "http:")) {
    throw new Error(
      "give the line CoCalc showed you, like https://cocalc.ai/c/R-...",
    );
  }
  if (
    u.protocol === "http:" &&
    !["localhost", "127.0.0.1"].includes(u.hostname)
  ) {
    throw new Error("pairing needs https");
  }
  return { origin: u.origin, request_id: m[1] };
}

/** The computers endpoints answer with small JSON objects. */
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const REQUEST_TIMEOUT_MS = 30_000;

/** A failure that may pass: the site unreachable, restarting (5xx) or slow. */
export class TransientError extends Error {}
/** The site says this computer is revoked: it ends for good. */
export class RevokedError extends Error {}
/** An answer bigger than we read: not something waiting fixes. */
class TooLargeError extends Error {}

/** How long pairing waits for the owner while the site can't be reached. */
const MAX_APPROVAL_WAIT_MS = 70 * 60 * 1000;

/** Sleep, but wake up "stopped" as soon as the caller aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("stopped"));
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    };
    const stop = () => {
      done();
      reject(new Error("stopped"));
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/**
 * One POST to the site's computers API. The site is untrusted until the
 * person at the machine confirms, so: no redirects (they could point this
 * machine at another origin, e.g. a local service), a timeout plus the
 * caller's abort signal, a byte cap read before parsing, and error text
 * cleaned before anyone prints it.
 */
export async function post<T>(
  origin: string,
  path: string,
  body: object,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${origin}/api/v2/computers/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (signal?.aborted) throw new Error("stopped");
    throw new TransientError(
      `could not reach ${origin}: ${clean((err as Error)?.message ?? err, 200)}`,
    );
  }
  let text: string;
  try {
    text = await readCapped(res, MAX_RESPONSE_BYTES);
  } catch (err) {
    if (signal?.aborted) throw new Error("stopped");
    // A connection reset or the timeout can come after the headers did.
    throw new (err instanceof TooLargeError ? Error : TransientError)(
      `${origin}: ${clean((err as Error)?.message ?? err, 200)}`,
    );
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new (res.status >= 500 ? TransientError : Error)(
      `${origin} answered ${res.status} without JSON`,
    );
  }
  if (data?.error != null) {
    const message = clean(data.error, 300);
    if (data.revoked === true) throw new RevokedError(message);
    throw new (data.transient === true ? TransientError : Error)(message);
  }
  if (!res.ok) {
    throw new (res.status >= 500 ? TransientError : Error)(
      `${origin} answered ${res.status}`,
    );
  }
  return data as T;
}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (reader == null) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new TooLargeError("the server's answer is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const NAME = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const PHRASE = /^[a-z]+(?:-[a-z]+){3}$/;
/** Control and bidi characters: never printed from the server as is. */
const UNSAFE_TEXT =
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/** Server text for the terminal: no control or bidi characters, bounded. */
function clean(value: unknown, max: number): string {
  return `${value ?? ""}`.replace(UNSAFE_TEXT, "?").slice(0, max);
}

/** This machine, as the owner will see it. */
function machine() {
  return {
    hostname: hostname().slice(0, 255),
    os: process.platform,
    arch: process.arch,
    user: userInfo().username,
  };
}

/**
 * Pair this machine: show the request, claim it, show the pairing phrase,
 * and wait for the owner's approval.
 */
export async function pairComputer({
  url,
  io,
  pollMs = 2000,
  signal,
}: {
  url: string;
  io: ConnectorIO;
  pollMs?: number;
  signal?: AbortSignal;
}): Promise<Connection> {
  const { origin, request_id } = parsePairingUrl(url);
  const view: any = await post<unknown>(
    origin,
    "pairing/view",
    { request_id },
    signal,
  );
  if (view?.request_id !== request_id || !NAME.test(`${view?.name}`)) {
    throw new Error("the server's answer is malformed");
  }
  if (view.state !== "pending") {
    throw new Error(
      `this request is ${clean(view.state, 40)}; make a new one in CoCalc`,
    );
  }
  io.log(
    [
      `${origin} asks to connect this computer:`,
      `  account:  ${clean(view.account_label, 200).replace(/\s+/g, " ")}`,
      `  name:     ${view.name}`,
      `  access:   FULL: anything running in the one project chosen for it in`,
      `            CoCalc, agents included, can run commands here as`,
      `            ${userInfo().username}, with all of your access, until it is`,
      `            revoked in CoCalc`,
    ].join("\n"),
  );
  // Always asked: connecting gives that project full trust here.
  if (!(await io.confirm("Connect this computer?"))) {
    throw new Error("not connected");
  }
  const claim = await post<PairingClaim>(
    origin,
    "pairing/claim",
    { request_id, machine: machine() },
    signal,
  );
  if (
    claim?.request_id !== request_id ||
    !SECRET.test(`${claim?.secret}`) ||
    !PHRASE.test(`${claim?.pairing_phrase}`)
  ) {
    throw new Error("the server's answer is malformed");
  }
  io.log(
    `\nPairing phrase:  ${claim.pairing_phrase}\n\nApprove it in CoCalc, after checking it shows exactly this phrase. Waiting...`,
  );

  // People take a while to approve, and the site may restart meanwhile:
  // only a real answer ends the wait, not a moment it can't be reached.
  const giveUpAt = Date.now() + MAX_APPROVAL_WAIT_MS;
  let lost = false;
  let pause = pollMs;
  let status: any;
  for (;;) {
    if (signal?.aborted) throw new Error("stopped");
    try {
      status = await post<unknown>(
        origin,
        "pairing/status",
        { request_id, secret: claim.secret },
        signal,
      );
    } catch (err) {
      if (!(err instanceof TransientError) || Date.now() > giveUpAt) throw err;
      if (!lost) {
        io.log(`${err.message}; still waiting (it may be restarting)...`);
        lost = true;
      }
      pause = Math.min(pause * 2, 30_000);
      await sleep(pause, signal);
      continue;
    }
    if (lost) {
      io.log("Reached it again. Waiting for approval...");
      lost = false;
      pause = pollMs;
    }
    if (status?.state === "approved") break;
    if (status?.state === "expired") {
      throw new Error(
        "The request expired before it was approved. Make a new one in CoCalc and run its line again.",
      );
    }
    if (status?.state === "declined") {
      throw new Error("The request was declined in CoCalc.");
    }
    if (status?.state !== "claimed") {
      throw new Error(`The request is ${clean(status?.state, 40)}.`);
    }
    await sleep(pollMs, signal);
  }
  if (!isValidUUID(status.computer_id) || !isValidUUID(status.project_id)) {
    throw new Error("the server's answer is malformed");
  }
  const computer_id: string = status.computer_id;
  const dir = join(computersDir(), computer_id);
  if (existsSync(dir)) {
    throw new Error(
      `${dir} already exists; this computer id is already paired here`,
    );
  }
  ensurePrivateDir(dir);
  const connection: Connection = {
    dir,
    origin,
    computer_id,
    // The name the person at the machine confirmed.
    name: view.name,
    project_id: status.project_id,
    token: claim.secret,
  };
  writeDurableJson(join(dir, "connection.json"), {
    origin,
    computer_id,
    name: connection.name,
    project_id: connection.project_id,
    token: connection.token,
  });
  io.log(`Approved: this computer is @${connection.name}.`);
  return connection;
}

/** A paired computer, from its files. */
export function loadConnection(computer_id?: string): Connection {
  const root = computersDir();
  if (computer_id != null && !isValidUUID(computer_id)) {
    throw new Error("a computer id is a UUID");
  }
  const ids =
    computer_id != null
      ? [computer_id]
      : existsSync(root)
        ? readdirSync(root, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
        : [];
  const found = ids.filter(
    (id) => isValidUUID(id) && existsSync(join(root, id, "connection.json")),
  );
  if (found.length !== 1) {
    throw new Error(
      found.length === 0
        ? "no connected computer here: connect it with the line CoCalc shows"
        : `several computers here; name one: ${found.join(", ")}`,
    );
  }
  const dir = join(root, found[0]);
  const c = readJson<any>(join(dir, "connection.json"));
  if (
    c == null ||
    !isValidUUID(c.computer_id) ||
    !isValidUUID(c.project_id) ||
    !SECRET.test(`${c.token}`)
  ) {
    throw new Error("this computer's files are incomplete");
  }
  return {
    dir,
    origin: c.origin,
    computer_id: c.computer_id,
    name: c.name,
    project_id: c.project_id,
    token: c.token,
  };
}

export interface RunOptions {
  connection: Connection;
  io: ConnectorIO;
  signal?: AbortSignal;
  /** Tests: how to get a host token and open a conat connection. */
  hostConnection?: () => Promise<HostConnection>;
  openConat?: (host: HostConnection) => Client;
  /** Connect again this often (before the host token expires). */
  refreshMs?: number;
  /** Tests: called once each connection is subscribed. */
  onConnected?: (host: HostConnection) => void;
}

/** One connection to the host, serving until replaced or dropped. */
interface Session {
  client: Client;
  /** Resolves when the host drops it (or it is closed). */
  dropped: Promise<void>;
  /** A newer connection took over: close this one (not a drop). */
  retire(): void;
}

/**
 * Serve the computer's project until stopped, or until the site says the
 * computer is revoked (then every running command is stopped).
 */
export async function runConnector(opts: RunOptions): Promise<void> {
  const { connection, io, signal } = opts;
  const refreshMs = opts.refreshMs ?? HOST_TOKEN_REFRESH_MS;
  const hostConnection =
    opts.hostConnection ??
    (() =>
      post<HostConnection>(
        connection.origin,
        "connect",
        { computer_id: connection.computer_id, token: connection.token },
        signal,
      ));
  const openConat =
    opts.openConat ??
    ((host: HostConnection) =>
      connect({
        address: host.address,
        noCache: true,
        // A new token for each connection: never replay an old one.
        reconnection: false,
        // A computer may not subscribe to _INBOX (and makes no requests).
        disableInbox: true,
        auth: { bearer: host.token },
      } as any));
  // Every running command, and how to stop it (its whole process group).
  const running = new Map<Promise<void>, AbortController>();
  const stopRunning = () => {
    for (const stop of running.values()) stop.abort();
  };
  let current: Session | undefined;

  /**
   * An answer goes back on the newest connection: a command may outlive the
   * connection (and host token) it came on. Without one, it has nowhere to
   * go, and the command was stopped anyway (see onDropped).
   */
  const answer = async (reply_subject: string, data: unknown) => {
    await current?.client.publish(reply_subject, data).catch(() => {});
  };

  const handlers: SessionHandlers = {
    exec: (mesg) => {
      const reply_subject = replySubject(mesg);
      if (reply_subject == null) return;
      const stop = new AbortController();
      const task = (async () => {
        const result = await execReply(mesg.data, running.size, stop.signal);
        await answer(reply_subject, result);
      })().finally(() => running.delete(task));
      running.set(task, stop);
    },
    hello: (mesg) => {
      const hello: ComputerHello = {
        v: 1,
        computer_id: connection.computer_id,
        name: connection.name,
        ...machine(),
        running: running.size,
      };
      void mesg.respond(hello).catch(() => {});
    },
    // A command runs only while the computer is connected: dropped (the
    // host refused it, or the network went away), its answer would be lost
    // and its project may no longer be allowed to use it.
    onDropped: stopRunning,
  };

  let backoff = 1000;
  let unreachable = false;
  try {
    while (!signal?.aborted) {
      let host: HostConnection;
      try {
        host = await hostConnection();
      } catch (err) {
        if (err instanceof RevokedError) {
          io.log(`This computer was revoked in CoCalc: ${err.message}`);
          return;
        }
        if (signal?.aborted) break;
        if (!unreachable) {
          io.log(`connection: ${(err as Error).message ?? err}`);
          unreachable = true;
        }
        backoff = Math.min(backoff * 2, 60_000);
        await sleep(backoff * (0.5 + Math.random()), signal).catch(() => {});
        continue;
      }
      let next: Session;
      try {
        next = await openSession(openConat(host), host, connection, handlers);
      } catch (err) {
        if (signal?.aborted) break;
        io.log(`connection: ${(err as Error).message ?? err}`);
        backoff = Math.min(backoff * 2, 60_000);
        await sleep(backoff * (0.5 + Math.random()), signal).catch(() => {});
        continue;
      }
      // Make before break: the new connection serves before the old closes.
      const previous = current;
      current = next;
      previous?.retire();
      if (unreachable || backoff > 1000) io.log("connected again");
      else io.log(`connected (@${connection.name})`);
      unreachable = false;
      backoff = 1000;
      opts.onConnected?.(host);
      const until = Math.min(
        refreshMs,
        Math.max(0, host.expires_at - Date.now() - 60_000),
      );
      // Until it is time for a new token, or the host drops this one; then
      // the timer must not outlive the wait (it would keep this process up).
      const wake = new AbortController();
      await Promise.race([
        sleep(
          until,
          signal ? AbortSignal.any([signal, wake.signal]) : wake.signal,
        ).catch(() => {}),
        next.dropped,
      ]);
      wake.abort();
    }
  } finally {
    // Stopped or revoked: stop every command, then let them answer.
    stopRunning();
    await Promise.allSettled([...running.keys()]);
    current?.retire();
  }
}

interface SessionHandlers {
  exec: (mesg: any) => void;
  hello: (mesg: any) => void;
  onDropped: () => void;
}

/** The requester's reply inbox, if this is a request. */
function replySubject(mesg: any): string | undefined {
  const subject = mesg?.headers?.[REPLY_HEADER];
  return typeof subject === "string" && subject.startsWith("_INBOX.")
    ? subject
    : undefined;
}

async function openSession(
  client: Client,
  host: HostConnection,
  connection: Connection,
  handlers: SessionHandlers,
): Promise<Session> {
  let closed = false;
  let retired = false;
  let onDropped: () => void = () => {};
  const dropped = new Promise<void>((resolve) => (onDropped = resolve));
  const subs: { close(): void }[] = [];
  const close = () => {
    if (closed) return;
    closed = true;
    if (!retired) handlers.onDropped();
    onDropped();
    for (const sub of subs) sub.close();
    client.close();
  };
  try {
    const queue = `computer-${connection.computer_id}`;
    const exec = await client.subscribe(
      computerExecSubject(host.project_id, host.computer_id),
      { queue, receiveLimits: REQUEST_RECEIVE_LIMITS },
    );
    subs.push(exec);
    const hello = await client.subscribe(
      computerHelloSubject(host.project_id),
      {
        queue,
        receiveLimits: REQUEST_RECEIVE_LIMITS,
      },
    );
    subs.push(hello);
    client.conn?.on?.("disconnect", close);
    void (async () => {
      for await (const mesg of hello) handlers.hello(mesg);
    })();
    void (async () => {
      for await (const mesg of exec) handlers.exec(mesg);
    })();
  } catch (err) {
    retired = true; // never served: nothing of its own to stop
    close();
    throw err;
  }
  return {
    client,
    dropped,
    retire: () => {
      retired = true;
      close();
    },
  };
}

async function execReply(
  data: any,
  alreadyRunning: number,
  stop: AbortSignal,
): Promise<ComputerExecReply> {
  try {
    if (alreadyRunning >= MAX_RUNNING) {
      throw new OperationError(
        `${MAX_RUNNING} commands are already running here; wait for one to finish`,
      );
    }
    if (data?.v !== 1) throw new OperationError("unknown request version");
    const request = parseExecRequest(data.request);
    const result = await runExec(request, { workdir: homedir(), signal: stop });
    return { v: 1, ok: true, result };
  } catch (err) {
    return {
      v: 1,
      ok: false,
      error: clean((err as Error)?.message ?? err, 1000),
    };
  }
}
