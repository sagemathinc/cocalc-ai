/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  createInterBayProjectDetailsClient,
  type InterBayProjectDetailsApi,
  createInterBayHostConnectionClient,
  type InterBayHostConnectionApi,
  createInterBayProjectHostAuthTokenClient,
  type InterBayProjectHostAuthTokenApi,
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
  projectDetails(
    dest_bay: string,
    opts?: { timeout_ms?: number },
  ): InterBayProjectDetailsApi;
  hostConnection(
    dest_bay: string,
    opts?: { timeout_ms?: number },
  ): InterBayHostConnectionApi;
  projectHostAuthToken(
    dest_bay: string,
    opts?: { timeout_ms?: number },
  ): InterBayProjectHostAuthTokenApi;
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

  projectDetails(
    dest_bay: string,
    opts: { timeout_ms?: number } = {},
  ): InterBayProjectDetailsApi {
    return createInterBayProjectDetailsClient({
      client: this.client,
      dest_bay,
      timeout: opts.timeout_ms,
    });
  }

  hostConnection(
    dest_bay: string,
    opts: { timeout_ms?: number } = {},
  ): InterBayHostConnectionApi {
    return createInterBayHostConnectionClient({
      client: this.client,
      dest_bay,
      timeout: opts.timeout_ms,
    });
  }

  projectHostAuthToken(
    dest_bay: string,
    opts: { timeout_ms?: number } = {},
  ): InterBayProjectHostAuthTokenApi {
    return createInterBayProjectHostAuthTokenClient({
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
