import {
  messageData,
  type Subscription,
  type Headers,
  ConatError,
} from "@cocalc/conat/core/client";
import { ConatSocketBase } from "./base";
import { type TCP, createTCP } from "./tcp";
import {
  SOCKET_HEADER_CMD,
  SOCKET_HEADER_CONNECT_ATTEMPT,
  DEFAULT_COMMAND_TIMEOUT,
  type ConatSocketOptions,
  serverStatusSubject,
} from "./util";
import { EventIterator } from "@cocalc/util/event-iterator";
import { keepAlive, KeepAlive } from "./keepalive";
import { getLogger } from "@cocalc/conat/client";
import { once } from "@cocalc/util/async-utils";

const logger = getLogger("socket:client");

// DO NOT directly instantiate here -- instead, call the
// socket.connect method on ConatClient.

export class ConatSocketClient extends ConatSocketBase {
  queuedWrites: { data: any; headers?: Headers }[] = [];
  private tcp?: TCP;
  private alive?: KeepAlive;
  private serverId?: string;
  private loadBalancer?: (subject: string) => Promise<string>;
  private lifecycleReporter?: ConatSocketOptions["lifecycleReporter"];
  private nextConnectAttemptId = 0;
  private connectAttempts = new Map<
    number,
    { started_at: number; publish_ms?: number }
  >();
  private requestRetryInFlight = false;

  constructor(opts: ConatSocketOptions) {
    super(opts);
    this.loadBalancer = opts.loadBalancer;
    this.lifecycleReporter = opts.lifecycleReporter;
    // logger.silly("creating a client socket connecting to ", this.subject);
    this.initTCP();
    this.on("ready", () => {
      for (const mesg of this.queuedWrites) {
        this.sendDataToServer(mesg);
      }
    });
    if (this.tcp == null) {
      throw Error("bug");
    }
  }

  // subject to send messages/data to the socket server.
  serverSubject = (): string => {
    if (!this.serverId) {
      throw Error("no server selected");
    }
    return `${this.subject}.server.${this.serverId}.${this.id}`;
  };

  channel(channel: string) {
    return this.client.socket.connect(this.subject + "." + channel, {
      desc: `${this.desc ?? ""}.channel('${channel}')`,
      maxQueueSize: this.maxQueueSize,
    }) as ConatSocketClient;
  }

  private initKeepAlive = () => {
    this.alive?.close();
    this.alive = keepAlive({
      role: "client",
      ping: async () =>
        await this.request(null, {
          headers: { [SOCKET_HEADER_CMD]: "ping" },
          timeout: this.keepAliveTimeout,
        }),
      disconnect: this.disconnect,
      keepAlive: this.keepAlive,
    });
  };

  initTCP() {
    if (this.tcp != null) {
      throw Error("this.tcp already initialized");
    }
    // request = send a socket request mesg to the server side of the socket
    // either ack what's received or asking for a resend of missing data.
    const request = async (mesg, opts?) =>
      await this.client.request(this.serverSubject(), mesg, {
        ...opts,
        headers: { ...opts?.headers, [SOCKET_HEADER_CMD]: "socket" },
      });

    this.tcp = createTCP({
      request,
      role: this.role,
      reset: this.disconnect,
      send: this.sendToServer,
      size: this.maxQueueSize,
    });

    this.client.on("disconnected", this.tcp.send.resendLastUntilAcked);

    this.tcp.recv.on("message", (mesg) => {
      this.emit("data", mesg.data, mesg.headers);
    });
    this.tcp.send.on("drain", () => {
      this.emit("drain");
    });
  }

  drain = async () => {
    await this.tcp?.send.drain();
  };

  private sendCommandToServer = async (
    cmd: "close" | "ping",
    timeout = DEFAULT_COMMAND_TIMEOUT,
  ) => {
    const headers = {
      [SOCKET_HEADER_CMD]: cmd,
      id: this.id,
    };
    const subject = this.serverSubject();
    const resp = await this.client.request(subject, null, {
      headers,
      timeout,
    });

    const value = resp.data;
    // logger.silly("sendCommandToServer: got resp", { cmd, value, subject });
    if (value?.error) {
      throw Error(value?.error);
    } else {
      return value;
    }
  };

  private sendConnectCommand = () => {
    const attempt = ++this.nextConnectAttemptId;
    const started_at = Date.now();
    this.client.publishSync(this.serverSubject(), null, {
      headers: {
        [SOCKET_HEADER_CMD]: "connect",
        [SOCKET_HEADER_CONNECT_ATTEMPT]: attempt,
        id: this.id,
      },
    });
    this.connectAttempts.set(attempt, {
      started_at,
      publish_ms: Date.now() - started_at,
    });
  };

  private handleConnected = (mesg) => {
    const rawAttempt = mesg.headers?.[SOCKET_HEADER_CONNECT_ATTEMPT];
    const attempt =
      typeof rawAttempt == "number"
        ? rawAttempt
        : typeof rawAttempt == "string"
          ? Number(rawAttempt)
          : undefined;
    const connectAttempt =
      attempt != null && !Number.isNaN(attempt)
        ? this.connectAttempts.get(attempt)
        : undefined;
    const waitForClientInterestMs =
      typeof mesg.headers?.waitForClientInterestMs == "number"
        ? mesg.headers.waitForClientInterestMs
        : undefined;
    const details = {
      publish_ms: connectAttempt?.publish_ms,
      response_wait_ms:
        connectAttempt == null
          ? undefined
          : Date.now() - connectAttempt.started_at,
      wait_for_client_interest_ms: waitForClientInterestMs,
    };
    this.connectAttempts.clear();
    if (this.state == "ready") {
      return;
    }
    this.setState("ready");
    this.lifecycleReporter?.("connect_command_done", details);
    this.lifecycleReporter?.("ready");
    this.initKeepAlive();
  };

  private processMessages = async () => {
    for await (const mesg of this.sub!) {
      this.alive?.recv();
      const cmd = mesg.headers?.[SOCKET_HEADER_CMD];
      if (cmd == "connected") {
        this.handleConnected(mesg);
      } else if (cmd == "socket") {
        this.tcp?.send.handleRequest(mesg);
      } else if (cmd == "close") {
        this.close();
        return;
      } else if (cmd == "ping") {
        // logger.silly("responding to ping from server", this.id);
        mesg.respondSync(null);
      } else if (mesg.isRequest()) {
        // logger.silly("client got request");
        this.emit("request", mesg);
      } else {
        // logger.silly("client got data"); //, { data: mesg.data });
        this.tcp?.recv.process(mesg);
      }
    }
  };

  private waitForConnected = async () => {
    this.connectAttempts.clear();
    let timeout = 500;
    while (this.state != "closed" && this.state != "ready") {
      this.lifecycleReporter?.("connect_command_start");
      this.sendConnectCommand();
      try {
        await once(this, "ready", timeout);
        return;
      } catch {
        // Retry until the ready event arrives or the socket closes.
      }
      timeout = Math.min(10_000, Math.round(timeout * 1.3));
    }
  };

  private getServerId = async () => {
    let id;
    this.lifecycleReporter?.("get_server_id_start");
    if (this.loadBalancer != null) {
      logger.debug("getting server id from load balancer");
      id = await this.loadBalancer(this.subject);
    } else {
      logger.debug("getting server id from socket server");
      const resp = await this.client.request(
        serverStatusSubject(this.subject),
        null,
      );
      ({ id } = resp.data);
    }
    this.serverId = id;
    this.lifecycleReporter?.("get_server_id_done", { server_id: id });
  };

  protected async run() {
    if (this.state == "closed") {
      return;
    }
    //     console.log(
    //       "client socket -- subscribing to ",
    //       `${this.subject}.client.${this.id}`,
    //     );
    try {
      await this.getServerId();

      //  logger.silly("run: getting subscription");
      this.lifecycleReporter?.("subscribe_start");
      const sub = this.client.subscribeSync(
        `${this.subject}.client.${this.id}`,
      );
      this.lifecycleReporter?.("subscribe_done");
      // @ts-ignore
      if (this.state == "closed") {
        sub.close();
        return;
      }
      // the disconnect function does this.sub.close()
      this.sub = sub;
      const processMessages = this.processMessages();
      await this.waitForConnected();

      if (this.state != "ready") {
        throw Error("failed to connect");
      }
      await processMessages;
    } catch (err) {
      // logger.silly("socket connect failed", err);
      this.disconnect();
    }
  }

  private sendDataToServer = (mesg) => {
    this.client.publishSync(this.serverSubject(), null, {
      raw: mesg.raw,
      headers: mesg.headers,
    });
  };

  private sendToServer = (mesg) => {
    if (this.state != "ready") {
      this.queuedWrites.push(mesg);
      while (this.queuedWrites.length > this.maxQueueSize) {
        this.queuedWrites.shift();
      }
      return;
    }
    // @ts-ignore
    if (this.state == "closed") {
      throw Error("closed");
    }
    if (this.role == "server") {
      throw Error("sendToServer is only for use by the client");
    } else {
      // we are the client, so write to server
      this.sendDataToServer(mesg);
    }
  };

  request = async (data, options?) => {
    const timeout = options?.timeout;
    const doRequest = async () => {
      try {
        await this.waitUntilReady(timeout);
      } catch {
        throw Error("request timed out");
      }
      if (this.state == "closed") {
        throw Error("closed");
      }
      // console.log("sending request from client ", { subject, data, options });
      return await this.client.request(this.serverSubject(), data, {
        waitForInterest: options?.waitForInterest ?? true,
        ...options,
      });
    };

    try {
      return await doRequest();
    } catch (err) {
      if (!this.shouldRetrySocketRequest(err)) {
        throw err;
      }
      await this.reconnectAndWait(timeout);
      return await doRequest();
    }
  };

  requestMany = async (data, options?): Promise<Subscription> => {
    const timeout = options?.timeout;
    const doRequestMany = async () => {
      await this.waitUntilReady(timeout);
      return await this.client.requestMany(this.serverSubject(), data, {
        waitForInterest: options?.waitForInterest ?? true,
        ...options,
      });
    };
    try {
      return await doRequestMany();
    } catch (err) {
      if (!this.shouldRetrySocketRequest(err)) {
        throw err;
      }
      await this.reconnectAndWait(timeout);
      return await doRequestMany();
    }
  };

  private shouldRetrySocketRequest = (err: unknown): boolean => {
    if (this.state == "closed") {
      return false;
    }
    const msg = `${(err as any)?.message ?? err ?? ""}`.toLowerCase();
    const code = `${(err as any)?.code ?? ""}`.toLowerCase();
    if (code === "503" || code === "408") {
      return true;
    }
    return (
      msg.includes("no subscribers matching") ||
      msg.includes("request timed out") ||
      msg === "timeout"
    );
  };

  private reconnectAndWait = async (timeout?: number): Promise<void> => {
    if (this.requestRetryInFlight) {
      await this.waitUntilReady(timeout);
      return;
    }
    this.requestRetryInFlight = true;
    try {
      this.disconnect();
      await this.waitUntilReady(timeout);
    } finally {
      this.requestRetryInFlight = false;
    }
  };

  async end({ timeout = 3000 }: { timeout?: number } = {}) {
    if (this.state == "closed") {
      return;
    }
    this.reconnection = false;
    this.ended = true;
    // tell server we're done
    try {
      await this.sendCommandToServer("close", timeout);
    } catch {}
    this.close();
  }

  close() {
    if (this.state == "closed") {
      return;
    }
    this.connectAttempts.clear();
    this.sub?.close();
    if (this.tcp != null) {
      this.client.removeListener(
        "disconnected",
        this.tcp.send.resendLastUntilAcked,
      );
    }
    this.queuedWrites = [];
    // tell server we're gone (but don't wait)
    (async () => {
      try {
        await this.sendCommandToServer("close");
      } catch {}
    })();
    if (this.tcp != null) {
      this.tcp.send.close();
      this.tcp.recv.close();
      // @ts-ignore
      delete this.tcp;
    }
    this.alive?.close();
    delete this.alive;
    super.close();
  }

  // writes will raise an exception if: (1) the socket is closed code='EPIPE', or (2)
  // you hit maxQueueSize un-ACK'd messages, code='ENOBUFS'
  write = (data, { headers }: { headers?: Headers } = {}): void => {
    // @ts-ignore
    if (this.state == "closed") {
      throw new ConatError("closed", { code: "EPIPE" });
    }
    const mesg = messageData(data, { headers });
    this.tcp?.send.process(mesg);
  };

  iter = () => {
    return new EventIterator<[any, Headers]>(this, "data");
  };
}
