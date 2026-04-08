/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  createInterBayProjectControlClient,
  type InterBayProjectControlApi,
  createInterBayProjectLroClient,
  type InterBayProjectLroApi,
  createInterBayProjectReferenceClient,
  type InterBayProjectReferenceApi,
} from "@cocalc/conat/inter-bay/api";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";

export interface InterBayBridge {
  readonly bay_id: string;
  projectControl(
    dest_bay: string,
    opts?: { timeout_ms?: number },
  ): InterBayProjectControlApi;
  projectReference(
    dest_bay: string,
    opts?: { timeout_ms?: number },
  ): InterBayProjectReferenceApi;
  projectLro(
    dest_bay: string,
    opts?: { timeout_ms?: number },
  ): InterBayProjectLroApi;
}

class LocalOnlyInterBayBridge implements InterBayBridge {
  public readonly bay_id = getConfiguredBayId();
  private readonly client = getInterBayFabricClient();

  projectControl(
    dest_bay: string,
    opts: { timeout_ms?: number } = {},
  ): InterBayProjectControlApi {
    return createInterBayProjectControlClient({
      client: this.client,
      dest_bay,
      timeout: opts.timeout_ms,
    });
  }

  projectReference(
    dest_bay: string,
    opts: { timeout_ms?: number } = {},
  ): InterBayProjectReferenceApi {
    return createInterBayProjectReferenceClient({
      client: this.client,
      dest_bay,
      timeout: opts.timeout_ms,
    });
  }

  projectLro(
    dest_bay: string,
    opts: { timeout_ms?: number } = {},
  ): InterBayProjectLroApi {
    return createInterBayProjectLroClient({
      client: this.client,
      dest_bay,
      timeout: opts.timeout_ms,
    });
  }
}

let bridge: InterBayBridge | undefined;

export function getInterBayBridge(): InterBayBridge {
  bridge ??= new LocalOnlyInterBayBridge();
  return bridge;
}
