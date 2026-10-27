/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Internal RunPod client on the REST API v2 (https://api.runpod.io/v2; v1 is
// retired 2026-11-15). Read-only for now: catalog, availability, pods and
// pod billing. Writes come with the allowlist request builder and the key
// authority; see the GPU bring-your-own-key design. Callers outside the
// authority must never get a RunpodClient or the key it holds.
//
// The credential-bearing origins are fixed: there is deliberately no option
// to point this client (and so the escrowed key) anywhere else.

import {
  billingRecordView,
  podView,
  type RunpodBillingRecord,
  type RunpodPodView,
} from "./views";

const API_ORIGIN = "https://api.runpod.io";
// Account balance has no v2 endpoint yet; it is the only GraphQL read and is
// isolated in getAccountBalance(). Remove when v2 exposes balance/spend
// (GraphQL is deprecated, retiring in early 2027).
const GRAPHQL_URL = "https://api.runpod.io/graphql";
// Cloudflare in front of RunPod rejects some default user agents (error
// 1010), so always send our own.
const USER_AGENT = "cocalc-runpod/1";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_PAGES = 50;

type Fetch = typeof globalThis.fetch;

export interface RunpodClientOptions {
  apiKey: string;
  // for tests; production uses the global fetch
  fetch?: Fetch;
  timeoutMs?: number;
}

// What went wrong, without any provider text. Callers decide from `kind`:
// - "auth": the key itself was rejected (401). It may have been revoked.
// - "forbidden": a valid key lacks permission for this one action (403).
//   This does NOT mean the key can't clean up; probe inventory/terminate.
export type RunpodErrorKind =
  | "auth"
  | "forbidden"
  | "not_found"
  | "invalid"
  | "conflict"
  | "rate_limited"
  | "provider"
  | "network"
  | "protocol";

const MESSAGES: Record<RunpodErrorKind, string> = {
  auth: "RunPod rejected the API key",
  forbidden: "the RunPod API key lacks permission for this action",
  not_found: "RunPod resource not found",
  invalid: "RunPod rejected the request as invalid",
  conflict: "RunPod reported a conflict",
  rate_limited: "RunPod rate limit reached",
  provider: "RunPod returned a server error",
  network: "could not reach RunPod",
  protocol: "unexpected response from RunPod",
};

// Known provider error details we act on, matched exactly. Anything else in
// an error body is discarded.
const KNOWN_REASONS = {
  "Organizations are not enabled for this user": "organizations_not_enabled",
} as const;
export type RunpodErrorReason =
  (typeof KNOWN_REASONS)[keyof typeof KNOWN_REASONS];

// Provider bodies are never kept: an error body can echo request fields
// such as env values, so only the status, a fixed message and (for a few
// exactly matched details) a reason code survive.
export class RunpodApiError extends Error {
  readonly kind: RunpodErrorKind;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  readonly reason?: RunpodErrorReason;

  constructor(
    kind: RunpodErrorKind,
    status?: number,
    retryAfterSeconds?: number,
    reason?: RunpodErrorReason,
  ) {
    super(status ? `${MESSAGES[kind]} (${status})` : MESSAGES[kind]);
    this.name = "RunpodApiError";
    this.kind = kind;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.reason = reason;
  }
}

// Who a key acts for. Keys created in a RunPod team act for that team
// (organization); accounts without organizations are personal. Rotation and
// cleanup compare this, never a user id.
export type RunpodProviderIdentity =
  | { kind: "organization"; id: string; name?: string }
  | { kind: "personal"; id: string };

export interface RunpodAccountBalance {
  balance?: number;
  spendPerHour?: number;
  spendLimitPerHour?: number;
}

export type RunpodCloud = "SECURE" | "COMMUNITY";

export type RunpodAvailability = "NONE" | "LOW" | "MEDIUM" | "HIGH";

export class RunpodClient {
  readonly #apiKey: string;
  readonly #fetch: Fetch;
  readonly #timeoutMs: number;

  constructor(opts: RunpodClientOptions) {
    const apiKey = `${opts.apiKey ?? ""}`.trim();
    if (!apiKey || /\s/.test(apiKey)) {
      throw new Error("a RunPod API key is required");
    }
    this.#apiKey = apiKey;
    this.#fetch = opts.fetch ?? globalThis.fetch;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // Never let the key show up through util.inspect or JSON logging.
  toJSON() {
    return { provider: "runpod" };
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return "RunpodClient {}";
  }

  // Raw catalog rows (GET /v2/catalog/gpus) with pod availability for one
  // cloud tier: availability differs by tier and RunPod defaults to SECURE.
  // Normalize with catalog.ts.
  async listGpuTypes(cloud: RunpodCloud): Promise<any[]> {
    if (cloud !== "SECURE" && cloud !== "COMMUNITY") {
      throw new Error("invalid RunPod cloud");
    }
    const body = await this.get("/v2/catalog/gpus", {
      include: "AVAILABILITY",
      product: "POD",
      cloud,
    });
    if (!Array.isArray(body?.gpus)) throw new RunpodApiError("protocol");
    return body.gpus;
  }

  async listDataCenters(): Promise<any[]> {
    const body = await this.get("/v2/catalog/datacenters");
    if (!Array.isArray(body?.dataCenters)) {
      throw new RunpodApiError("protocol");
    }
    return body.dataCenters;
  }

  async getProviderIdentity(): Promise<RunpodProviderIdentity> {
    try {
      const org = await this.get("/v2/organization");
      if (!(typeof org?.id === "string" && org.id)) {
        throw new RunpodApiError("protocol");
      }
      return {
        kind: "organization",
        id: org.id,
        name: typeof org.name === "string" ? org.name : undefined,
      };
    } catch (err) {
      if (
        !(err instanceof RunpodApiError) ||
        err.reason !== "organizations_not_enabled"
      ) {
        throw err;
      }
    }
    // No organizations on this account: the key acts for the personal
    // account. GraphQL until v2 exposes the personal account id.
    const me = (await this.graphql("query { myself { id } }"))?.myself;
    if (!(typeof me?.id === "string" && me.id)) {
      throw new RunpodApiError("protocol");
    }
    return { kind: "personal", id: me.id };
  }

  async listPods(): Promise<RunpodPodView[]> {
    const pods: RunpodPodView[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.get("/v2/pods", cursor ? { cursor } : {});
      if (
        !Array.isArray(body?.pods) ||
        typeof body.pagination?.hasNextPage !== "boolean"
      ) {
        throw new RunpodApiError("protocol");
      }
      for (const raw of body.pods) {
        // A row we can't parse could be a live pod: never drop it silently.
        const pod = podView(raw);
        if (!pod) throw new RunpodApiError("protocol");
        pods.push(pod);
      }
      if (!body.pagination.hasNextPage) return pods;
      const next = body.pagination.nextCursor;
      if (!(typeof next === "string" && next)) {
        throw new RunpodApiError("protocol");
      }
      cursor = next;
    }
    // An inventory that may be incomplete must not look complete: callers
    // reconcile against it.
    throw new RunpodApiError("protocol");
  }

  async getPod(podId: string): Promise<RunpodPodView | undefined> {
    let raw: any;
    try {
      raw = await this.get(`/v2/pods/${checkPodId(podId)}`);
    } catch (err) {
      if (err instanceof RunpodApiError && err.kind === "not_found") {
        return undefined;
      }
      throw err;
    }
    const pod = podView(raw);
    if (!pod || pod.id !== podId) throw new RunpodApiError("protocol");
    return pod;
  }

  async listPodBilling(
    opts: {
      podId?: string;
      bucketSize?: "hour" | "day" | "week" | "month" | "year";
      startTime?: string;
      endTime?: string;
    } = {},
  ): Promise<RunpodBillingRecord[]> {
    const query: Record<string, string> = {
      bucketSize: opts.bucketSize ?? "hour",
    };
    // RunPod requires both or neither (400 otherwise).
    if ((opts.startTime == null) !== (opts.endTime == null)) {
      throw new Error("startTime and endTime must be given together");
    }
    if (opts.podId) query.podId = checkPodId(opts.podId);
    if (opts.startTime) query.startTime = checkTime(opts.startTime);
    if (opts.endTime) query.endTime = checkTime(opts.endTime);
    const body = await this.get("/v2/billing/pods", query);
    // Spend reconciliation reads this: a partial or malformed answer must
    // fail rather than undercount.
    if (
      !Array.isArray(body?.records) ||
      !Number.isInteger(body.metadata?.recordCount) ||
      body.metadata.recordCount !== body.records.length
    ) {
      throw new RunpodApiError("protocol");
    }
    return body.records.map((raw: unknown) => {
      const record = billingRecordView(raw);
      if (!record || (opts.podId && record.podId !== opts.podId)) {
        throw new RunpodApiError("protocol");
      }
      return record;
    });
  }

  // Temporary GraphQL read; see GRAPHQL_URL. Not an identity: use
  // getProviderIdentity() for that.
  async getAccountBalance(): Promise<RunpodAccountBalance> {
    const me = (
      await this.graphql(
        "query { myself { clientBalance currentSpendPerHr spendLimit } }",
      )
    )?.myself;
    if (!me || typeof me !== "object") throw new RunpodApiError("protocol");
    return {
      balance: finite(me.clientBalance),
      spendPerHour: finite(me.currentSpendPerHr),
      spendLimitPerHour: finite(me.spendLimit),
    };
  }

  private async graphql(query: string): Promise<any> {
    const res = await this.request(GRAPHQL_URL, {
      method: "POST",
      body: JSON.stringify({ query }),
    });
    const body = await this.parse(res);
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      // A valid key without account scope answers 200 with UNAUTHORIZED; a
      // rejected key gets HTTP 401 before this point.
      throw new RunpodApiError(
        body.errors[0]?.extensions?.code === "UNAUTHORIZED"
          ? "forbidden"
          : "provider",
      );
    }
    return body?.data;
  }

  private async get(
    path: string,
    query: Record<string, string> = {},
  ): Promise<any> {
    const qs = new URLSearchParams(query).toString();
    const res = await this.request(
      `${API_ORIGIN}${path}${qs ? `?${qs}` : ""}`,
      {
        method: "GET",
      },
    );
    return await this.parse(res);
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
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      // Network errors can carry the request; keep nothing from them.
      throw new RunpodApiError("network");
    }
  }

  private async parse(res: Response): Promise<any> {
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new RunpodApiError(
        errorKind(res.status),
        res.status,
        retryAfter(res.headers.get("retry-after")),
        knownReason(text),
      );
    }
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new RunpodApiError("protocol", res.status);
    }
  }
}

function errorKind(status: number): RunpodErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "invalid";
  return "provider";
}

function knownReason(text: string): RunpodErrorReason | undefined {
  let detail: unknown;
  try {
    detail = JSON.parse(text)?.detail;
  } catch {
    return undefined;
  }
  return typeof detail === "string" &&
    Object.prototype.hasOwnProperty.call(KNOWN_REASONS, detail)
    ? KNOWN_REASONS[detail as keyof typeof KNOWN_REASONS]
    : undefined;
}

function retryAfter(v: string | null): number | undefined {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function checkPodId(podId: string): string {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(podId)) {
    throw new Error("invalid RunPod pod id");
  }
  return podId;
}

function checkTime(t: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(t)) {
    throw new Error("invalid time; use an ISO 8601 UTC timestamp");
  }
  return t;
}
