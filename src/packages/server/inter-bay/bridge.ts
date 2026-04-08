/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";

export interface InterBayRequestOptions {
  dest_bay: string;
  subject: string;
  data?: any;
  timeout_ms?: number;
}

export interface InterBayBridge {
  readonly bay_id: string;
  request<T = any>(opts: InterBayRequestOptions): Promise<T>;
}

class LocalOnlyInterBayBridge implements InterBayBridge {
  public readonly bay_id = getConfiguredBayId();
  private readonly client = getInterBayFabricClient();

  async request<T = any>(opts: InterBayRequestOptions): Promise<T> {
    const resp = await this.client.request(opts.subject, opts.data, {
      timeout: opts.timeout_ms,
    });
    if (resp.data?.error) {
      throw new Error(`${resp.data.error}`);
    }
    return resp.data as T;
  }
}

let bridge: InterBayBridge | undefined;

export function getInterBayBridge(): InterBayBridge {
  bridge ??= new LocalOnlyInterBayBridge();
  return bridge;
}
