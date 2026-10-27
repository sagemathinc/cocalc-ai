/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Internal RunPod API client. Read-only for now: account, catalog,
// availability, pods and billing. Writes (create/terminate) come with the
// allowlist request builder and the key authority; see the GPU
// bring-your-own-key design. Callers outside the authority must never get a
// RunpodClient or the key it holds.

import { podView, scrubText, type RunpodPodView } from "./scrub";

export const RUNPOD_REST_URL = "https://rest.runpod.io/v1";
export const RUNPOD_GRAPHQL_URL = "https://api.runpod.io/graphql";
// Cloudflare in front of rest.runpod.io rejects some default user agents
// (error 1010), so always send our own.
const USER_AGENT = "cocalc-runpod/1";
const DEFAULT_TIMEOUT_MS = 30_000;

type Fetch = typeof globalThis.fetch;

export interface RunpodClientOptions {
  apiKey: string;
  fetch?: Fetch;
  timeoutMs?: number;
  restUrl?: string;
  graphqlUrl?: string;
}

export class RunpodApiError extends Error {
  readonly status?: number;
  // True when the key itself was refused: it may have been revoked or
  // narrowed in the RunPod console.
  readonly unauthorized: boolean;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "RunpodApiError";
    this.status = status;
    this.unauthorized = status === 401 || status === 403;
  }
}

export interface RunpodAccount {
  id: string;
  clientBalance?: number;
  currentSpendPerHr?: number;
  spendLimit?: number;
  underBalance?: boolean;
}

export interface RunpodBillingRecord {
  time?: string;
  amount?: number;
  timeBilledMs?: number;
  diskSpaceBilledGb?: number;
  podId?: string;
  gpuTypeId?: string;
}

export class RunpodClient {
  readonly #apiKey: string;
  readonly #fetch: Fetch;
  readonly #timeoutMs: number;
  readonly #restUrl: string;
  readonly #graphqlUrl: string;

  constructor(opts: RunpodClientOptions) {
    const apiKey = `${opts.apiKey ?? ""}`.trim();
    if (!apiKey || /\s/.test(apiKey)) {
      throw new Error("a RunPod API key is required");
    }
    this.#apiKey = apiKey;
    this.#fetch = opts.fetch ?? globalThis.fetch;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#restUrl = opts.restUrl ?? RUNPOD_REST_URL;
    this.#graphqlUrl = opts.graphqlUrl ?? RUNPOD_GRAPHQL_URL;
  }

  // Never let the key show up through util.inspect or JSON logging.
  toJSON() {
    return { provider: "runpod" };
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return "RunpodClient {}";
  }

  async getAccount(): Promise<RunpodAccount> {
    const data = await this.graphql(
      "query { myself { id clientBalance currentSpendPerHr spendLimit underBalance } }",
    );
    const me = data?.myself;
    if (!me || typeof me.id !== "string") {
      throw new RunpodApiError("RunPod returned no account");
    }
    return {
      id: me.id,
      clientBalance: num(me.clientBalance),
      currentSpendPerHr: num(me.currentSpendPerHr),
      spendLimit: num(me.spendLimit),
      underBalance:
        typeof me.underBalance === "boolean" ? me.underBalance : undefined,
    };
  }

  // Raw catalog rows; normalize with catalog.ts.
  async listGpuTypes(): Promise<any[]> {
    const data = await this.graphql(
      `query { gpuTypes { id displayName memoryInGb secureCloud communityCloud
        securePrice communityPrice secureSpotPrice communitySpotPrice
        lowestPrice(input: { gpuCount: 1 }) { stockStatus } } }`,
    );
    return Array.isArray(data?.gpuTypes) ? data.gpuTypes : [];
  }

  async listDataCenters(): Promise<any[]> {
    const data = await this.graphql(
      `query { dataCenters { id name location listed
        gpuAvailability { gpuTypeId stockStatus } } }`,
    );
    return Array.isArray(data?.dataCenters) ? data.dataCenters : [];
  }

  async listPods(): Promise<RunpodPodView[]> {
    const rows = await this.rest("/pods");
    return (Array.isArray(rows) ? rows : [])
      .map(podView)
      .filter((p): p is RunpodPodView => p != null);
  }

  async getPod(podId: string): Promise<RunpodPodView | undefined> {
    try {
      return podView(await this.rest(`/pods/${checkPodId(podId)}`));
    } catch (err) {
      if (err instanceof RunpodApiError && err.status === 404) return undefined;
      throw err;
    }
  }

  async listPodBilling(
    opts: {
      podId?: string;
      bucketSize?: "hour" | "day" | "week" | "month" | "year";
      startTime?: string;
      endTime?: string;
    } = {},
  ): Promise<RunpodBillingRecord[]> {
    const params = new URLSearchParams({
      grouping: "podId",
      bucketSize: opts.bucketSize ?? "hour",
    });
    if (opts.podId) params.set("podId", checkPodId(opts.podId));
    if (opts.startTime) params.set("startTime", opts.startTime);
    if (opts.endTime) params.set("endTime", opts.endTime);
    const rows = await this.rest(`/billing/pods?${params}`);
    return (Array.isArray(rows) ? rows : []).map((r: any) => ({
      time: typeof r?.time === "string" ? r.time : undefined,
      amount: num(r?.amount),
      timeBilledMs: num(r?.timeBilledMs),
      diskSpaceBilledGb: num(r?.diskSpaceBilledGb),
      podId: typeof r?.podId === "string" ? r.podId : undefined,
      gpuTypeId: typeof r?.gpuTypeId === "string" ? r.gpuTypeId : undefined,
    }));
  }

  private async rest(path: string): Promise<any> {
    const res = await this.request(`${this.#restUrl}${path}`, {
      method: "GET",
    });
    return await this.parse(res);
  }

  private async graphql(query: string): Promise<any> {
    const res = await this.request(this.#graphqlUrl, {
      method: "POST",
      body: JSON.stringify({ query }),
    });
    const body = await this.parse(res);
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      const code = body.errors[0]?.extensions?.code;
      const unauthorized = code === "UNAUTHORIZED" || code === "FORBIDDEN";
      throw new RunpodApiError(
        `RunPod GraphQL error: ${scrubText(body.errors[0]?.message ?? code)}`,
        unauthorized ? 403 : undefined,
      );
    }
    return body?.data;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      // Network errors can carry the request; report only their kind.
      const name = (err as any)?.name ?? "Error";
      throw new RunpodApiError(`RunPod request failed (${name})`);
    }
  }

  private async parse(res: Response): Promise<any> {
    const text = await res.text();
    if (!res.ok) {
      throw new RunpodApiError(
        `RunPod returned ${res.status}${text ? `: ${scrubText(text)}` : ""}`,
        res.status,
      );
    }
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new RunpodApiError("RunPod returned invalid JSON", res.status);
    }
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function checkPodId(podId: string): string {
  if (!/^[a-z0-9]{6,32}$/.test(podId)) throw new Error("invalid RunPod pod id");
  return podId;
}
