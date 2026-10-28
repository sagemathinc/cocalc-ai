/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
POST /gpu/pod-host-key: a GPU pod reports its SSH host key, once, with the
one-time token CoCalc gave it at launch (GPU bring-your-own-key, step 4; the
contract is ~/ops2/runpod/HOSTKEY-REGISTRATION.md, approved 10-28).

A pod has no CoCalc identity, so this is plain HTTPS with a bearer token.
Everything about the request is checked here, before any database read or
inter-bay send: POST only, HTTPS (as the hub's trusted-proxy policy sees
it), the exact `Authorization: Bearer <token>` grammar with a canonical
token for a known bay, a JSON body of at most 2 KB with exactly
{pod_id, host_public_key}, one valid ed25519 key, and rate limits per
address and per token. Then the report runs on the token's authority bay
(here, or forwarded there with a bounded timeout).

No CORS headers and no cookies are used, answers are fixed words with
no-store, and nothing about the request (headers, body, token) is logged.
*/

import { createHash } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import LRU from "lru-cache";
import getLogger from "@cocalc/backend/logger";
import {
  getConfiguredBayId,
  getConfiguredClusterBayCatalog,
} from "@cocalc/server/bay-config";
import {
  MAX_HOSTKEY_BODY_BYTES,
  parseHostkeyAuthorization,
  parseHostkeyReport,
  type HostkeyToken,
} from "@cocalc/server/gpu/hostkey-token";
import { parseEd25519PublicKey } from "@cocalc/util/gpu/ssh-key";
import type { GpuHostKeyResult } from "@cocalc/util/gpu/types";
import { checkAndRecordCount } from "./connector-rate-limit";

const logger = getLogger("hub:servers:app:gpu-pod-host-key");

export const GPU_POD_HOST_KEY_PATH = "/gpu/pod-host-key";
const FORWARD_TIMEOUT_MS = 15_000;

export interface GpuPodHostKeyDeps {
  // for tests
  isSecure?: (req: Request) => boolean;
  knownBays?: () => Set<string>;
  thisBay?: () => string;
  register?: (opts: {
    token: HostkeyToken;
    pod_id: string;
    host_public_key: string;
  }) => Promise<GpuHostKeyResult>;
  forward?: (
    dest_bay: string,
    opts: { token: HostkeyToken; pod_id: string; host_public_key: string },
  ) => Promise<GpuHostKeyResult>;
  limits?: { global: number; ip: number; token: number };
  clientAddress?: (req: Request) => string;
}

// Per minute.
const LIMITS = { global: 600, ip: 30, token: 10 };

function knownBays(): Set<string> {
  const bays = new Set(
    getConfiguredClusterBayCatalog().map((info) => info.bay_id),
  );
  bays.add(getConfiguredBayId());
  return bays;
}

async function registerHere(opts: {
  token: HostkeyToken;
  pod_id: string;
  host_public_key: string;
}): Promise<GpuHostKeyResult> {
  const { registerHostKeyLocal } = await import("@cocalc/server/gpu/hostkey");
  return await registerHostKeyLocal(opts);
}

async function forwardTo(
  dest_bay: string,
  opts: { token: HostkeyToken; pod_id: string; host_public_key: string },
): Promise<GpuHostKeyResult> {
  const { createInterBayAccountLocalClient } =
    await import("@cocalc/conat/inter-bay/api");
  const { getInterBayFabricClient } =
    await import("@cocalc/server/inter-bay/fabric");
  return await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay,
    timeout: FORWARD_TIMEOUT_MS,
  }).gpuRegisterHostKey(opts);
}

function answer(res: Response, status: number, result: string) {
  res.status(status).json({ result });
}

export default function initGpuPodHostKey(
  router: Router,
  deps: GpuPodHostKeyDeps = {},
): void {
  const counts = new LRU<string, number>({ max: 10_001, ttl: 60_000 });
  const jsonBody = express.json({
    limit: MAX_HOSTKEY_BODY_BYTES,
    strict: true,
    type: () => true,
  });

  router.all(GPU_POD_HOST_KEY_PATH, (req, res) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    if (req.method !== "POST") {
      res.set("Allow", "POST");
      return answer(res, 405, "method_not_allowed");
    }
    // req.secure follows the hub's trusted-proxy policy, not client headers.
    if (!(deps.isSecure ?? ((r) => r.secure))(req)) {
      return answer(res, 400, "https_required");
    }
    const limits = deps.limits ?? LIMITS;
    const address = deps.clientAddress
      ? deps.clientAddress(req)
      : (req.ip ?? req.socket.remoteAddress ?? "unknown");
    const ip = createHash("sha256").update(address).digest("hex");
    // Per IP first: the site-wide allowance is charged only for requests an
    // IP's own allowance admits, so one client can't use it up for all pods.
    if (
      !checkAndRecordCount(counts, `ip:${ip}`, limits.ip) ||
      !checkAndRecordCount(counts, "global", limits.global)
    ) {
      res.set("Retry-After", "60");
      return answer(res, 429, "rate_limited");
    }
    const token = parseHostkeyAuthorization(req.get("authorization"));
    if (
      token == null ||
      !(deps.knownBays ?? knownBays)().has(token.authority_bay_id)
    ) {
      return answer(res, 401, "unauthorized");
    }
    if (!checkAndRecordCount(counts, `token:${token.token_id}`, limits.token)) {
      res.set("Retry-After", "60");
      return answer(res, 429, "rate_limited");
    }
    if (!req.is("application/json")) {
      return answer(res, 415, "json_required");
    }
    jsonBody(req, res, (err?: unknown) => {
      if (err) return answer(res, 400, "invalid");
      const report = parseHostkeyReport(req.body);
      if (report == null) return answer(res, 400, "invalid");
      try {
        parseEd25519PublicKey(report.host_public_key);
      } catch {
        return answer(res, 400, "invalid");
      }
      const opts = { token, ...report };
      const here = (deps.thisBay ?? getConfiguredBayId)();
      const run =
        token.authority_bay_id === here
          ? (deps.register ?? registerHere)(opts)
          : (deps.forward ?? forwardTo)(token.authority_bay_id, opts);
      run.then(
        (r) => answer(res, r.status, r.result),
        (err) => {
          // never the error text: it could carry request data
          logger.warn("pod host-key report failed", {
            kind: `${(err as any)?.code ?? (err as any)?.name ?? "error"}`,
          });
          answer(res, 503, "try_again");
        },
      );
    });
  });
}
