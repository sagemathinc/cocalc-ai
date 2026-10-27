/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Which ZeroMQ transport the Jupyter client uses, chosen once by
COCALC_JUPYTER_ZMQ, before the first socket:

- unset or "js": the pure-JS ZMTP transport (./zmtp.ts);
- "native": the native zeromq.js addon, the fallback while it still ships.

Changing it needs a restart of the process.  An invalid value, or "native"
in a build without the addon, is an error at the first kernel start; there
is never a silent fallback.

For every project on a project host, set it in
/etc/cocalc/project-host.local.env and restart project-host: new project
starts get it (project-runner/run/env.ts).  A project's own environment
setting, applied later, wins.
*/

import { getLogger } from "@cocalc/backend/logger";
import * as zmtp from "./zmtp";

const logger = getLogger("jupyter:zmq");

export const TRANSPORT_ENV = "COCALC_JUPYTER_ZMQ";

export interface JupyterSocket extends AsyncIterable<Buffer[]> {
  linger: number;
  readonly closed: boolean;
  connect(url: string): void | Promise<void>;
  disconnect(url: string): void;
  close(): void;
  send(frames: (Buffer | string)[]): unknown;
}

export interface JupyterSubscriber extends JupyterSocket {
  subscribe(prefix?: string): void;
}

interface Transport {
  name: "js" | "native";
  Dealer: new (options: { routingId: string }) => JupyterSocket;
  Subscriber: new () => JupyterSubscriber;
}

let chosen: Transport | undefined;

export function selectTransport(
  value = process.env[TRANSPORT_ENV],
  // (tests: a build without the addon)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  loadNative: () => any = () => require("zeromq"),
): Transport {
  if (value == null || value === "" || value === "js") {
    const log = (...args: any[]) => logger.debug(...args);
    return {
      name: "js",
      Dealer: class extends zmtp.Dealer {
        constructor(options: { routingId: string }) {
          super({ ...options, log });
        }
      },
      Subscriber: class extends zmtp.Subscriber {
        constructor() {
          super({ log });
        }
      },
    };
  }
  if (value === "native") {
    let zmq;
    try {
      zmq = loadNative();
    } catch (err) {
      throw new Error(
        `${TRANSPORT_ENV}=native, but the native zeromq transport isn't available in this build: ${err}`,
      );
    }
    // Jupyter closes its sockets explicitly; leaving the global zeromq context
    // in blocky mode can keep test and short-lived CLI processes alive at exit.
    zmq.context.blocky = false;
    return { name: "native", Dealer: zmq.Dealer, Subscriber: zmq.Subscriber };
  }
  throw new Error(
    `${TRANSPORT_ENV}=${JSON.stringify(value)} isn't a Jupyter transport: use "js" (the default) or "native"`,
  );
}

/** The process's transport: chosen at the first call, and fixed after it. */
export function transport(): Transport {
  if (chosen == null) {
    chosen = selectTransport();
    logger.debug(`Jupyter ZeroMQ transport: ${chosen.name}`);
  }
  return chosen;
}
