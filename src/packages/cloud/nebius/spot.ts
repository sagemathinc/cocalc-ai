/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Nebius Spot in max-price mode (#684): live spot prices and the immutable
// per-(platform, cap) pricing policies that cap a preemptible VM's price.

import {
  ComputeInstanceSpec,
  ComputeInstanceSpecV1,
  CreatePricingPolicyRequest,
  GetPricingPolicyRequest,
  MaxPriceV1,
  PricingMethod,
  PricingPolicySpec,
  PricingPolicyStatus_SchedulingState,
  PricingPolicyStatus_State,
} from "@nebius/js-sdk/api/nebius/billing/v1/index";
import { ListSpotPricesRequest } from "@nebius/js-sdk/api/nebius/billing/v1alpha1/index";
import {
  GetByNameRequest,
  ResourceMetadata,
} from "@nebius/js-sdk/api/nebius/common/v1/index";
import { Long } from "@nebius/js-sdk/runtime/protos/index";
import {
  nebiusSpotPolicyName,
  nebiusSpotPriceWithinCap,
} from "@cocalc/util/nebius-spot-pricing";
import type { NebiusClient } from "./client";

export type NebiusSpotClient = Pick<
  NebiusClient,
  "pricingPolicies" | "spotPrices"
>;

export interface NebiusSpotQuote {
  region: string;
  platform: string;
  price_per_gpu_hour: string;
  effective_time?: string;
  quoted_at: string;
}

export class NebiusSpotPriceUnavailableError extends Error {
  constructor(region: string, platform: string) {
    super(
      `Nebius Spot price for '${platform}' in '${region}' is unavailable right now; use Standard pricing`,
    );
    this.name = "NebiusSpotPriceUnavailableError";
  }
}

export class NebiusSpotPriceAboveCapError extends Error {
  readonly max_price_per_gpu_hour: string;
  constructor(maxPricePerGpuHour: string) {
    super(
      `Nebius's spot price is above this VM's cap ($${maxPricePerGpuHour} per GPU-hour), so it can't start on Spot now; try again later or switch it to Standard`,
    );
    this.name = "NebiusSpotPriceAboveCapError";
    this.max_price_per_gpu_hour = maxPricePerGpuHour;
  }
}

const MAX_SPOT_PRICE_PAGES = 50;

function isNotFound(err: unknown): boolean {
  const message = String((err as any)?.message ?? err);
  const code = (err as any)?.code;
  return message.includes("NOT_FOUND") || code === "NOT_FOUND" || code === 5;
}

function isAlreadyExists(err: unknown): boolean {
  const message = String((err as any)?.message ?? err);
  const code = (err as any)?.code;
  return (
    message.includes("ALREADY_EXISTS") ||
    code === "ALREADY_EXISTS" ||
    code === 6
  );
}

/** The live Nebius spot price per GPU-hour for one (region, platform). With
 * several matching SKUs the highest price wins, so a cap derived from it
 * covers all of them. Throws when no usable USD price is listed. */
export async function quoteNebiusSpotPrice(
  client: NebiusSpotClient,
  opts: { region: string; platform: string },
): Promise<NebiusSpotQuote> {
  const region = `${opts.region ?? ""}`.trim();
  const platform = `${opts.platform ?? ""}`.trim();
  if (!region || !platform) {
    throw new NebiusSpotPriceUnavailableError(region, platform);
  }
  let best: { value: string; effective?: string } | undefined;
  let pageToken = "";
  const seen = new Set<string>();
  for (let page = 0; page < MAX_SPOT_PRICE_PAGES; page++) {
    if (seen.has(pageToken)) {
      throw new Error("Nebius spot price listing repeated a page token");
    }
    seen.add(pageToken);
    const response = await client.spotPrices.list(
      ListSpotPricesRequest.create({
        pageSize: Long.fromNumber(1000),
        pageToken,
      }),
    );
    for (const item of response.items ?? []) {
      if (item.region !== region) continue;
      if (item.computeInstance?.platform !== platform) continue;
      const value = `${item.price?.value ?? ""}`.trim();
      if (`${item.price?.currency ?? ""}`.toUpperCase() !== "USD") continue;
      if (!/^\d+(?:\.\d+)?$/.test(value) || Number(value) <= 0) continue;
      if (best && Number(value) <= Number(best.value)) continue;
      best = {
        value,
        effective: item.effectiveTime?.toISOString?.(),
      };
    }
    pageToken = response.nextPageToken ?? "";
    if (!pageToken) break;
    if (page === MAX_SPOT_PRICE_PAGES - 1) {
      throw new Error("Nebius spot price listing has too many pages");
    }
  }
  if (!best) throw new NebiusSpotPriceUnavailableError(region, platform);
  return {
    region,
    platform,
    price_per_gpu_hour: best.value,
    effective_time: best.effective,
    quoted_at: new Date().toISOString(),
  };
}

function policyPlatform(policy: any): string | undefined {
  const versions = policy?.spec?.computeInstanceSpec?.versions;
  return versions?.$case === "v1" ? versions.v1?.platform : undefined;
}

function policyMaxPrice(policy: any): string | undefined {
  const versions = policy?.spec?.pricing?.versions;
  return versions?.$case === "maxPriceV1"
    ? versions.maxPriceV1?.maxPrice
    : undefined;
}

/** The id of the pricing policy for (platform, cap), created if missing. An
 * existing policy is only reused when it is exactly that cap; it is never
 * edited, because Nebius locks a policy's price while VMs run under it. */
export async function ensureNebiusSpotPricingPolicy(
  client: NebiusSpotClient,
  opts: { parentId: string; platform: string; max_price_per_gpu_hour: string },
): Promise<string> {
  const parentId = `${opts.parentId ?? ""}`.trim();
  if (!parentId) throw new Error("nebius parentId is required");
  const name = nebiusSpotPolicyName(opts.platform, opts.max_price_per_gpu_hour);
  const find = async (): Promise<string | undefined> => {
    let policy;
    try {
      policy = await client.pricingPolicies.getByName(
        GetByNameRequest.create({ parentId, name }),
      );
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
    if (
      policyPlatform(policy) !== opts.platform ||
      policyMaxPrice(policy) !== opts.max_price_per_gpu_hour
    ) {
      throw new Error(
        `Nebius pricing policy '${name}' does not match its platform and cap`,
      );
    }
    if (policy?.status?.state === PricingPolicyStatus_State.STATE_DELETING) {
      throw new Error(
        `Nebius pricing policy '${name}' is being deleted; retry`,
      );
    }
    const id = `${policy?.metadata?.id ?? ""}`.trim();
    if (!id) throw new Error(`Nebius pricing policy '${name}' has no ID`);
    return id;
  };
  const existing = await find();
  if (existing) return existing;
  try {
    const operation = await client.pricingPolicies.create(
      CreatePricingPolicyRequest.create({
        metadata: ResourceMetadata.create({ parentId, name }),
        spec: PricingPolicySpec.create({
          computeInstanceSpec: ComputeInstanceSpec.create({
            versions: {
              $case: "v1",
              v1: ComputeInstanceSpecV1.create({ platform: opts.platform }),
            },
          }),
          pricing: PricingMethod.create({
            versions: {
              $case: "maxPriceV1",
              maxPriceV1: MaxPriceV1.create({
                maxPrice: opts.max_price_per_gpu_hour,
              }),
            },
          }),
        }),
      }),
    );
    await operation.wait();
    const id = `${operation.resourceId() ?? ""}`.trim();
    if (id) return id;
  } catch (err) {
    // a concurrent create of the same (platform, cap) won the name
    if (!isAlreadyExists(err)) throw err;
  }
  const created = await find();
  if (!created) throw new Error(`Nebius pricing policy '${name}' not found`);
  return created;
}

export interface NebiusSpotPolicyStatus {
  id: string;
  platform?: string;
  max_price_per_gpu_hour?: string;
  ready: boolean;
  scheduling: "allowed" | "blocked" | "unknown";
}

export async function getNebiusSpotPolicyStatus(
  client: NebiusSpotClient,
  id: string,
): Promise<NebiusSpotPolicyStatus> {
  const policy = await client.pricingPolicies.get(
    GetPricingPolicyRequest.create({ id }),
  );
  const scheduling = policy?.status?.schedulingState;
  return {
    id,
    platform: policyPlatform(policy),
    max_price_per_gpu_hour: policyMaxPrice(policy),
    ready: policy?.status?.state === PricingPolicyStatus_State.STATE_ACTIVE,
    scheduling:
      scheduling ===
      PricingPolicyStatus_SchedulingState.SCHEDULING_STATE_ALLOWED
        ? "allowed"
        : scheduling ===
            PricingPolicyStatus_SchedulingState.SCHEDULING_STATE_BLOCKED
          ? "blocked"
          : "unknown",
  };
}

/** Whether a Spot VM under this policy may start now, from both Nebius's
 * scheduling state and a live price quote. Never allows a start it can't
 * confirm: a missing quote or cap refuses. */
export async function assertNebiusSpotStartable(
  client: NebiusSpotClient,
  opts: {
    policy_id: string;
    region: string;
    /** the cap the VM is billed at; a different policy cap never starts */
    expected_max_price_per_gpu_hour?: string;
  },
): Promise<void> {
  const status = await getNebiusSpotPolicyStatus(client, opts.policy_id);
  const cap = status.max_price_per_gpu_hour;
  if (!cap || !status.platform) {
    throw new Error(
      `Nebius pricing policy '${opts.policy_id}' has no platform or cap`,
    );
  }
  if (
    opts.expected_max_price_per_gpu_hour != null &&
    opts.expected_max_price_per_gpu_hour !== cap
  ) {
    throw new Error(
      `Nebius Spot instance runs under cap $${cap}, not its billed cap $${opts.expected_max_price_per_gpu_hour}; replace the instance`,
    );
  }
  if (status.scheduling === "blocked") {
    throw new NebiusSpotPriceAboveCapError(cap);
  }
  const quote = await quoteNebiusSpotPrice(client, {
    region: opts.region,
    platform: status.platform,
  });
  if (!nebiusSpotPriceWithinCap(quote.price_per_gpu_hour, cap)) {
    throw new NebiusSpotPriceAboveCapError(cap);
  }
}

/** For a Spot VM that Nebius stopped: its cap when the stop was because the
 * price rose above it (the policy is blocked), else undefined (a capacity
 * preemption, handled by the usual spot recovery). */
export async function nebiusSpotPriceStopCap(
  client: NebiusSpotClient,
  policyId: string,
): Promise<string | undefined> {
  const status = await getNebiusSpotPolicyStatus(client, policyId);
  return status.scheduling === "blocked"
    ? status.max_price_per_gpu_hour
    : undefined;
}
