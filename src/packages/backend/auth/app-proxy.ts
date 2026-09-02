// Strip this retired header at the final upstream boundary so stale clients
// cannot pass historical CoCalc routing metadata into user applications.
export const LEGACY_APP_PROXY_EXPOSURE_HEADER = "x-cocalc-app-exposure";
export const LEGACY_PUBLIC_APP_HOST_HEADER = "x-cocalc-public-app-host";
export const LEGACY_PUBLIC_APP_TOKEN_QUERY_PARAM = "cocalc_app_token";

const SHARED_CACHE_DIRECTIVE = /^(?:public|s-maxage\s*=)/i;

/**
 * Managed app responses are collaborator-authenticated. Preserve browser cache
 * tuning, but never let an app spec opt those responses into shared caches.
 */
export function normalizePrivateAppCacheControl(
  value: string | undefined,
  fallback = "private, max-age=60, must-revalidate",
): string {
  const normalized = `${value ?? ""}`.trim();
  if (!normalized) return fallback;
  const directives = normalized
    .split(",")
    .map((directive) => directive.trim())
    .filter(Boolean)
    .filter((directive) => !SHARED_CACHE_DIRECTIVE.test(directive));
  if (!directives.some((directive) => /^private$/i.test(directive))) {
    directives.unshift("private");
  }
  return directives.join(", ");
}

export function stripLegacyPublicAppRequestMetadata(req: {
  headers: Record<string, unknown>;
  url?: string;
}): void {
  delete req.headers[LEGACY_PUBLIC_APP_HOST_HEADER];
  try {
    const parsed = new URL(req.url ?? "/", "http://cocalc.invalid");
    if (!parsed.searchParams.has(LEGACY_PUBLIC_APP_TOKEN_QUERY_PARAM)) return;
    parsed.searchParams.delete(LEGACY_PUBLIC_APP_TOKEN_QUERY_PARAM);
    req.url = `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
  } catch {
    // Malformed request URLs are rejected by the normal proxy parser.
  }
}
