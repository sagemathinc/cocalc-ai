/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { ConatService } from "@cocalc/conat/service/typed";
import {
  createServiceClient,
  createServiceHandler,
} from "@cocalc/conat/service/typed";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";

import type {
  BillingAuthorityTransportRequest,
  BillingAuthorityTransportResponse,
} from "./protocol";

const SERVICE = "billing-authority";
const TIMEOUT_MS = 30_000;

interface BillingAuthorityInterBayApi {
  transport: (
    request: BillingAuthorityTransportRequest,
  ) => Promise<BillingAuthorityTransportResponse>;
}

export function billingAuthoritySubject(seedBayId: string): string {
  return `bay.${seedBayId}.rpc.billing-authority.transport`;
}

export async function callSeedBillingAuthority(
  request: BillingAuthorityTransportRequest,
): Promise<BillingAuthorityTransportResponse> {
  const seedBayId = getConfiguredClusterSeedBayId();
  const client = createServiceClient<BillingAuthorityInterBayApi>({
    client: getInterBayFabricClient(),
    service: SERVICE,
    subject: billingAuthoritySubject(seedBayId),
    timeout: TIMEOUT_MS,
  });
  return await client.transport(request);
}

export function createBillingAuthorityInterBayService({
  handle,
}: {
  handle: BillingAuthorityInterBayApi["transport"];
}): ConatService | undefined {
  const seedBayId = getConfiguredClusterSeedBayId();
  if (getConfiguredBayId() !== seedBayId) {
    return;
  }
  return createServiceHandler<BillingAuthorityInterBayApi>({
    client: getInterBayFabricClient({ noCache: true }),
    service: SERVICE,
    subject: billingAuthoritySubject(seedBayId),
    parallel: true,
    impl: { transport: handle },
  });
}
