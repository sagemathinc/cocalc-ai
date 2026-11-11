/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The ZeroMQ transport the Jupyter client uses: the pure-JS ZMTP transport
(./zmtp.ts).  The native zeromq.js addon, its fallback while the pure-JS one
proved itself, is gone, and with it COCALC_JUPYTER_ZMQ.
*/

import { getLogger } from "@cocalc/backend/logger";
import * as zmtp from "./zmtp";

const logger = getLogger("jupyter:zmq");

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
  Dealer: new (options: { routingId: string }) => JupyterSocket;
  Subscriber: new () => JupyterSubscriber;
}

let chosen: Transport | undefined;

/** The process's transport: the pure-JS ZMTP sockets, logging to jupyter:zmq. */
export function transport(): Transport {
  if (chosen == null) {
    const log = (...args: any[]) => logger.debug(...args);
    chosen = {
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
  return chosen;
}
