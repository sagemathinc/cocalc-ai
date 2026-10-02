import { LOCALE } from "./i18n/locale";

export const CANONICAL_PUBLIC_SITE_HOST = "cocalc.ai";
export const CANONICAL_PUBLIC_SITE_ORIGIN = `https://${CANONICAL_PUBLIC_SITE_HOST}`;

const COCALC_AI_ONLY_SECTIONS = new Set([
  "about",
  "features",
  "guides",
  "lang",
  "pricing",
  "products",
]);

export const COCALC_AI_ONLY_PATH_PREFIXES = [
  "/about",
  "/features",
  "/guides",
  "/lang",
  ...LOCALE.map((locale) => `/${locale}`),
  "/pricing",
  "/products",
];

export function normalizePublicSiteHost(host?: string): string {
  const normalized = `${host ?? ""}`
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  const bracketedIpv6 = normalized.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketedIpv6) return bracketedIpv6[1];
  return (normalized.match(/:/g)?.length ?? 0) <= 1
    ? normalized.replace(/:\d+$/, "")
    : normalized;
}

export function isCanonicalPublicSiteHost(host?: string): boolean {
  return normalizePublicSiteHost(host) === CANONICAL_PUBLIC_SITE_HOST;
}

// cocalc.ai itself: CoCalc Launchpad on the canonical host. Copy that names
// CoCalc.ai as the place to start, such as COCALC_AI_SIGN_UP_LABEL, shows only
// there. Every other site, including a customer-operated Launchpad or Rocket
// site and CoCalc Plus, signs visitors up on its own site. `config.dns` is the
// request host on both sides: the crawler fallback reads it from the request,
// and /customize sets it from the Host header for the browser.
export function isCocalcAiLaunchpad(config?: {
  cocalc_product?: string;
  dns?: string;
}): boolean {
  return (
    config?.cocalc_product === "launchpad" &&
    isCanonicalPublicSiteHost(config.dns)
  );
}

// Labels of the sign-up link for signed-out visitors, on public pages and in
// their crawler fallback.
export const COCALC_AI_SIGN_UP_LABEL = "Start on CoCalc.ai";
export const PUBLIC_SIGN_UP_LABEL = "Start using CoCalc";

// The sign-up label of a feature page for signed-out visitors, on the page and
// in its crawler fallback. A page's own `signUpLabel` names CoCalc.ai, so it
// shows on cocalc.ai only; other sites, and pages without one, get
// PUBLIC_SIGN_UP_LABEL. Renderers read the label here, not from the record.
export function getPublicFeatureSignUpLabel(
  page: { signUpLabel?: string },
  onCocalcAi: boolean,
): string {
  return (onCocalcAi && page.signUpLabel) || PUBLIC_SIGN_UP_LABEL;
}

export function isLockedDownPublicSiteHost(host?: string): boolean {
  const normalized = normalizePublicSiteHost(host);
  return (
    !normalized ||
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(`.${CANONICAL_PUBLIC_SITE_HOST}`)
  );
}

export function isCocalcAiOnlyPublicPath(path: string): boolean {
  return COCALC_AI_ONLY_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

export function isCocalcAiOnlyPublicSection(section: string): boolean {
  return COCALC_AI_ONLY_SECTIONS.has(section);
}
