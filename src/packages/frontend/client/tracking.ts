/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { WebappClient } from "./client";

export class TrackingClient {
  private client: WebappClient;
  private log_error_cache: { [error: string]: number } = {};

  constructor(client: WebappClient) {
    this.client = client;
  }

  log_error = (error: any): void => {
    if (typeof error != "string") {
      error = JSON.stringify(error);
    }
    const last = this.log_error_cache[error];
    if (last != null && Date.now() - last <= 1000 * 60 * 15) {
      return;
    }
    this.log_error_cache[error] = Date.now();
    (async () => {
      try {
        await this.client.conat_client.hub.system.logClientError({
          event: "error",
          error,
        });
      } catch (err) {
        console.log(`WARNING -- issue reporting error -- ${err}`);
      }
    })();
  };

  webapp_error = async (opts: object): Promise<void> => {
    await this.client.conat_client.hub.system.webappError(opts);
  };
}
