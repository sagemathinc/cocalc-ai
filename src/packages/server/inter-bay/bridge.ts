/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { dispatchProjectControlRpc } from "@cocalc/server/inter-bay/project-control";

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

  async request<T = any>(opts: InterBayRequestOptions): Promise<T> {
    if (opts.dest_bay !== this.bay_id) {
      throw new Error(
        `inter-bay transport not implemented yet for remote bay ${opts.dest_bay}`,
      );
    }
    return (await dispatchProjectControlRpc(opts.subject, opts.data)) as T;
  }
}

let bridge: InterBayBridge | undefined;

export function getInterBayBridge(): InterBayBridge {
  bridge ??= new LocalOnlyInterBayBridge();
  return bridge;
}
