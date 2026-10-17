/*
Which web pages may open a hub Conat websocket authenticated by a cookie.

Browsers attach cookies to websockets opened by any page, and CORS does not
apply to websockets, but browsers always send (and pages cannot forge) the
Origin of a websocket handshake. So when a connection is authenticated only
by a cookie (remember_me, or the API-key and project-secret cookies) and it
carries an Origin, that Origin must be approved.

Approved origins come only from configuration, never from the request: the
configured site origin, the bay public origins, and
COCALC_CONAT_ALLOWED_ORIGINS (comma separated, e.g. a dev server). The list
is cached, the lookup is bounded in time, and a failed lookup keeps the last
complete list.

Connections without an Origin are not browsers (the CLI, the mobile app,
service clients) and are not affected. Explicit credentials (bearer,
computer login, project secret in the auth payload) and internal cookies
(bay credential, system accounts, hub password) are not checked here.

COCALC_CONAT_ORIGIN_POLICY: "report" (default for the first rollout) logs and
counts connections that enforcement would refuse; "enforce" refuses them;
"off" disables the check.
*/

import { Counter } from "prom-client";
import { getLogger } from "@cocalc/backend/logger";
import {
  getClusterBayPublicOrigins,
  getSitePublicOrigin,
} from "@cocalc/server/bay-public-origin";

const logger = getLogger("conat-auth:browser-origin");

export type CookieCredential =
  | "remember-me"
  | "api-key-cookie"
  | "project-secret-cookie";
export type OriginPolicyMode = "enforce" | "report" | "off";

const rejections = new Counter({
  name: "cocalc_conat_cookie_origin_rejections_total",
  help: "Cookie-authenticated hub Conat connections from an unapproved page",
  labelNames: ["credential", "reason", "mode"],
});

export function originPolicyMode(): OriginPolicyMode {
  const value = `${process.env.COCALC_CONAT_ORIGIN_POLICY ?? ""}`
    .trim()
    .toLowerCase();
  return value === "enforce" || value === "off" ? value : "report";
}

// A serialized http(s) origin exactly as browsers send it.
export function parseOrigin(value: unknown): string | undefined {
  const raw = `${value ?? ""}`.trim();
  if (!raw || raw === "null") return;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    if (url.origin.toLowerCase() !== raw.toLowerCase()) return;
    return url.origin.toLowerCase();
  } catch {
    return;
  }
}

function originOfUrl(value: unknown): string | undefined {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    return url.origin.toLowerCase();
  } catch {
    return;
  }
}

function header(headers: any, name: string): string {
  const value = headers?.[name];
  return `${Array.isArray(value) ? value[0] : (value ?? "")}`.trim();
}

const CACHE_MS = 60_000;
// A list older than this is not used, even when a refresh fails.
const MAX_STALE_MS = 10 * 60_000;
const LOOKUP_TIMEOUT_MS = 2_000;
let cached: { origins: Set<string>; at: number } | undefined;

async function loadConfiguredOrigins(): Promise<Set<string>> {
  const origins = new Set<string>();
  const site = originOfUrl(await getSitePublicOrigin());
  if (site) origins.add(site);
  for (const origin of Object.values(
    await getClusterBayPublicOrigins({ strict: true }),
  )) {
    const parsed = originOfUrl(origin);
    if (parsed) origins.add(parsed);
  }
  for (const value of `${process.env.COCALC_CONAT_ALLOWED_ORIGINS ?? ""}`.split(
    ",",
  )) {
    const parsed = originOfUrl(value);
    if (parsed) origins.add(parsed);
  }
  return origins;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("approved origin lookup timed out")),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// At most one lookup runs at a time: callers that time out stop waiting,
// but the lookup keeps running and later callers reuse it. A lookup still
// running after LOAD_MAX_AGE_MS is abandoned (and if it finishes later, its
// result is ignored). After a lookup fails or a caller times out, callers
// fail fast for RETRY_COOLDOWN_MS instead of each waiting; turning callers
// away does not extend the cooldown. So a hanging configuration read costs
// at most one lookup per minute, not one per connection.
const LOAD_MAX_AGE_MS = 60_000;
const RETRY_COOLDOWN_MS = 10_000;
let generation = 0;
let inflight:
  | { promise: Promise<Set<string>>; started: number; generation: number }
  | undefined;
let cooldownUntil = 0;

class CooldownError extends Error {
  constructor() {
    super("approved origin lookup recently failed");
  }
}

function startCooldown(): void {
  cooldownUntil = Math.max(cooldownUntil, Date.now() + RETRY_COOLDOWN_MS);
}

function startLoad(load: () => Promise<Set<string>>): Promise<Set<string>> {
  const now = Date.now();
  if (now < cooldownUntil) {
    return Promise.reject(new CooldownError());
  }
  if (inflight != null && now - inflight.started < LOAD_MAX_AGE_MS) {
    return inflight.promise;
  }
  const mine = ++generation;
  const promise = load().then((origins) => {
    // A newer lookup replaced this one: don't let a late, abandoned result
    // overwrite what it found.
    if (mine === generation) {
      cached = { origins, at: Date.now() };
    }
    return origins;
  });
  const entry = { promise, started: now, generation: mine };
  inflight = entry;
  promise.then(
    () => {
      if (inflight === entry) inflight = undefined;
    },
    (err) => {
      if (inflight === entry) inflight = undefined;
      if (mine === generation) startCooldown();
      // Logged once per failed lookup, not once per waiting caller.
      logger.warn("approved origin lookup failed", { err: `${err}` });
    },
  );
  return promise;
}

// Wait for the shared lookup, but at most timeoutMs. A real timeout starts
// the cooldown; being turned away by the cooldown does not extend it.
async function waitForLoad(
  load: () => Promise<Set<string>>,
  timeoutMs: number,
): Promise<Set<string>> {
  try {
    return await withTimeout(startLoad(load), timeoutMs);
  } catch (err) {
    if (!(err instanceof CooldownError)) startCooldown();
    throw err;
  }
}

// The approved origins, from a cache refreshed every minute. While a list
// less than 10 minutes old exists, connections never wait: the stale list
// is used and refreshed in the background. Without a usable list, wait for
// a bounded lookup and throw if it fails.
export async function approvedOrigins({
  load = loadConfiguredOrigins,
  timeoutMs = LOOKUP_TIMEOUT_MS,
}: {
  load?: () => Promise<Set<string>>;
  timeoutMs?: number;
} = {}): Promise<Set<string>> {
  const now = Date.now();
  if (cached != null) {
    const age = now - cached.at;
    if (age < CACHE_MS) return cached.origins;
    if (age < MAX_STALE_MS) {
      // Failures are logged inside startLoad.
      startLoad(load).catch(() => {});
      return cached.origins;
    }
  }
  return await waitForLoad(load, timeoutMs);
}

export function resetApprovedOriginsForTests(): void {
  cached = undefined;
  inflight = undefined;
  cooldownUntil = 0;
}

export function resetPendingForTests(): void {
  inflight = undefined;
  cooldownUntil = 0;
}

// Why the connection must be refused, or undefined if it is acceptable.
export async function cookieOriginRejection(
  headers: Record<string, unknown>,
  approved: () => Promise<Set<string>> = () => approvedOrigins(),
): Promise<string | undefined> {
  const originHeader = header(headers, "origin");
  // Browsers always send Origin on websockets: no Origin means a non-browser
  // client, which a malicious page cannot be.
  if (!originHeader) return;
  const origin = parseOrigin(originHeader);
  if (!origin) return "invalid or opaque origin";
  if ((await approved()).has(origin)) return;
  return "origin not allowed";
}

const lastLogged = new Map<string, number>();

// Throws when the connection must be refused (enforce mode only).
export async function assertCookieOrigin(
  headers: Record<string, unknown>,
  credential: CookieCredential,
  approved?: () => Promise<Set<string>>,
): Promise<void> {
  const mode = originPolicyMode();
  if (mode === "off") return;
  let reason: string | undefined;
  try {
    reason = await cookieOriginRejection(headers, approved);
  } catch {
    // No approved list could be loaded (the failure itself is logged once
    // by the lookup): refuse when enforcing, but only connections that carry
    // a browser Origin; only count and log (rate limited) otherwise.
    reason = "approved origins unavailable";
  }
  if (!reason) return;
  rejections.inc({ credential, reason, mode });
  const origin = header(headers, "origin") || "(none)";
  const key = `${credential}|${reason}|${origin}`;
  const now = Date.now();
  if (now - (lastLogged.get(key) ?? 0) > 60_000) {
    lastLogged.set(key, now);
    if (lastLogged.size > 1000) lastLogged.clear();
    logger.warn(
      "cookie-authenticated conat connection from an unapproved page",
      {
        credential,
        reason,
        origin: origin.slice(0, 200),
        mode,
      },
    );
  }
  if (mode === "enforce") {
    throw Error(
      reason === "approved origins unavailable"
        ? "unable to verify connection origin"
        : "cross-site connection refused",
    );
  }
}
