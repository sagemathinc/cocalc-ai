/*
DEVELOPMENT:

~/cocalc/src/packages/backend$ node
> require('@cocalc/backend/conat'); c = require('@cocalc/conat/client').getClient()
> c.state
'connected'
*/

import { init, close as closeTime } from "./time";
import { EventEmitter } from "events";
import { type Client as ConatClient } from "@cocalc/conat/core/client";
import {
  FALLBACK_LOGGER,
  setConatLoggerFactory,
  type Logger,
} from "./logger";
export { getLogger } from "./logger";

interface Client {
  conat: (opts?) => ConatClient;
  account_id?: string;
  project_id?: string;
  getLogger?: (name) => Logger;
  // if defined, causes a client-defined version of reconnecting.
  reconnect?: () => Promise<void>;
}

type State = "closed" | "connected" | "connecting" | "disconnected";

export class ClientWithState extends EventEmitter {
  conatClient?: ConatClient;
  account_id?: string;
  project_id?: string;
  state: State = "disconnected";
  _getLogger?: (name) => Logger;
  _reconnect?: () => Promise<void>;
  conat: () => ConatClient;

  constructor(client: Client) {
    super();
    // many things potentially listen for these events -- way more than 10 things.
    this.setMaxListeners(1000);
    // this.conat only ever returns *ONE* connection
    this.conat = () => {
      if (this.state == "closed") {
        throw Error("client already closed");
      }
      if (this.conatClient) {
        return this.conatClient;
      }
      this.conatClient = client.conat();
      return this.conatClient;
    };
    this.account_id = client.account_id;
    this.project_id = client.project_id;
    this._getLogger = client.getLogger;
    this._reconnect = client.reconnect;
  }

  numSubscriptions = () => {
    this.conatClient?.numSubscriptions() ?? 0;
  };

  reconnect = async () => {
    await this._reconnect?.();
  };

  getLogger = (name): Logger => {
    if (this._getLogger != null) {
      return this._getLogger(name);
    } else {
      return FALLBACK_LOGGER;
    }
  };

  close = () => {
    this.conatClient?.close();
    this.setConnectionState("closed");
    this.removeAllListeners();
    delete this.conatClient;
  };

  private setConnectionState = (state: State) => {
    if (state == this.state) {
      return;
    }
    this.state = state;
    this.emit(state);
    this.emit("state", state);
  };
}

// do NOT do this until some explicit use of conat is initiated, since we shouldn't
// connect to conat until something tries to do so.
let timeInitialized = false;
function initTime() {
  if (timeInitialized) {
    return;
  }
  timeInitialized = true;
  init();
}

let globalClient: null | ClientWithState = null;
export function setConatClient(client: Client) {
  globalClient = new ClientWithState(client);
  setConatLoggerFactory(client.getLogger);
}

export function closeConatClientForTests(): void {
  if (!process.env.COCALC_TEST_MODE) {
    return;
  }
  try {
    globalClient?.close();
  } catch {
    // best-effort test cleanup only
  }
  globalClient = null;
  setConatLoggerFactory(undefined);
  closeTime();
}

export async function reconnect() {
  await globalClient?.reconnect();
}

export const conat: () => ConatClient = () => {
  if (globalClient == null) {
    throw Error("must set the global Conat client");
  }
  initTime();
  return globalClient.conat();
};

export function getClient(): ClientWithState {
  if (globalClient == null) {
    throw Error("must set the global Conat client");
  }
  initTime();
  return globalClient;
}

export function numSubscriptions(): number {
  return globalClient?.numSubscriptions() ?? 0;
}
