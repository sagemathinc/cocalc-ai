import { EventEmitter } from "events";
import { Dealer, Subscriber, context } from "zeromq";
import { Message } from "./message";
import type { JupyterMessage } from "./types";

//import { getLogger } from "@cocalc/backend/logger";
//const logger = getLogger("jupyter:zmq");

// Jupyter closes its sockets explicitly; leaving the global zeromq context in
// blocky mode can keep test and short-lived CLI processes alive at exit.
context.blocky = false;

type JupyterSocketName = "iopub" | "shell" | "stdin" | "control";

export const ZMQ_TYPE = {
  iopub: "sub",
  stdin: "dealer",
  shell: "dealer",
  control: "dealer",
} as const;

export interface JupyterConnectionInfo {
  version: number;
  iopub_port: number;
  shell_port: number;
  stdin_port: number;
  control_port: number;
  signature_scheme: "hmac-sha256";
  hb_port: number;
  ip: string;
  key: string;
  transport: "tcp" | "ipc";
}

export async function jupyterSockets(
  config: JupyterConnectionInfo,
  identity: string,
) {
  const sockets = new JupyterSockets(config, identity);
  await sockets.init();
  return sockets;
}

export class JupyterSockets extends EventEmitter {
  private sockets?: {
    iopub: Subscriber;
    stdin: Dealer;
    shell: Dealer;
    control: Dealer;
  };
  private readonly listenTasks: Promise<void>[] = [];

  constructor(
    private config: JupyterConnectionInfo,
    private identity: string,
  ) {
    super();
  }

  close = () => {
    if (this.sockets != null) {
      for (const name of Object.keys(this.sockets) as JupyterSocketName[]) {
        const socket = this.sockets[name];
        if (socket == null) continue;
        try {
          socket.linger = 0;
        } catch {
          // best effort cleanup
        }
        try {
          socket.disconnect(connectionString(this.config, name));
        } catch {
          // best effort cleanup
        }
        try {
          socket.close();
        } catch {
          // best effort cleanup
        }
        delete this.sockets[name];
      }
      delete this.sockets;
    }
    this.removeAllListeners();
  };

  waitUntilClosed = async () => {
    await Promise.allSettled(this.listenTasks);
  };

  send = (message: JupyterMessage) => {
    if (this.sockets == null) {
      throw Error("JupyterSockets not initialized");
    }
    const name = message.channel;
    if (name == "iopub") {
      throw Error("name must not be iopub");
    }
    const socket = this.sockets[name];
    if (socket == null) {
      throw Error(`invalid socket name '${name}'`);
    }

    //logger.debug("send message", message);
    const jMessage = new Message(message);
    socket.send(
      jMessage._encode(
        this.config.signature_scheme.slice("hmac-".length),
        this.config.key,
      ),
    );
  };

  init = async () => {
    const names = Object.keys(ZMQ_TYPE);
    const v = await Promise.all(
      names.map((name: JupyterSocketName) => this.createSocket(name)),
    );
    const sockets: any = {};
    let i = 0;
    for (const name of names) {
      sockets[name] = v[i];
      i += 1;
    }
    this.sockets = sockets;
  };

  private createSocket = async (name: JupyterSocketName) => {
    const zmqType = ZMQ_TYPE[name];
    let socket;
    if (zmqType == "dealer") {
      socket = new Dealer({ routingId: this.identity });
    } else if (zmqType == "sub") {
      socket = new Subscriber();
    } else {
      throw Error(`bug -- invalid zmqType ${zmqType}`);
    }
    socket.linger = 0;
    const url = connectionString(this.config, name);
    await socket.connect(url);
    // console.log("connected to", url);
    const listenTask = this.listen(name, socket).catch((err) => {
      if (!socket.closed) {
        throw err;
      }
    });
    this.listenTasks.push(listenTask);
    return socket;
  };

  private listen = async (name: JupyterSocketName, socket) => {
    try {
      if (ZMQ_TYPE[name] == "sub") {
        // subscribe to everything --
        //   https://zeromq.github.io/zeromq.js/classes/Subscriber.html#subscribe
        socket.subscribe();
      }
      for await (const data of socket) {
        const mesg = Message._decode(
          data,
          this.config.signature_scheme.slice("hmac-".length),
          this.config.key,
        );
        this.emit(name, mesg);
      }
    } catch (err) {
      if (!socket.closed) {
        throw err;
      }
    }
  };
}

export const connectionString = (
  config: JupyterConnectionInfo,
  name: JupyterSocketName,
) => {
  const portDelimiter = config.transport === "tcp" ? ":" : "-";
  const port = config[`${name}_port` as keyof JupyterConnectionInfo];
  if (!port) {
    throw new Error(`Port not found for name "${name}"`);
  }
  return `${config.transport}://${config.ip}${portDelimiter}${port}`;
};
