/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The public Home page experiment: several versions of Home, one picked at
// random for each anonymous page view, compared by what visitors then do.
//
// Nothing is stored in the browser and nothing identifies a visitor. The
// version travels only in the sign-up link (?home=<id>), and the server keeps
// aggregate counts per version and day (see server/public-home-experiment).
// Signed-in visitors and the crawler fallback always get the default.

// Every version the frontend can render. A version must be listed here to be
// assigned or counted; the site setting chooses which ones run.
export const PUBLIC_HOME_VARIANTS = ["default"] as const;
export type PublicHomeVariant = string;

export const PUBLIC_HOME_DEFAULT_VARIANT = "default";

// The query parameter that carries the version into the sign-up flow, and
// that previews a version without counting it.
export const PUBLIC_HOME_VARIANT_PARAM = "home";

export const PUBLIC_HOME_EXPERIMENT_EVENTS = [
  // Home was shown with this version.
  "view",
  // The sign-up page was opened from this version's sign-up link.
  "cta",
  // An account was created from that sign-up page.
  "signup",
] as const;
export type PublicHomeExperimentEvent =
  (typeof PUBLIC_HOME_EXPERIMENT_EVENTS)[number];

export interface PublicHomeExperimentArm {
  id: string;
  weight: number;
}

const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

export function isPublicHomeVariantId(
  id: unknown,
  known: readonly string[] = PUBLIC_HOME_VARIANTS,
): id is string {
  return typeof id === "string" && ID_RE.test(id) && known.includes(id);
}

export function isPublicHomeExperimentEvent(
  event: unknown,
): event is PublicHomeExperimentEvent {
  return (PUBLIC_HOME_EXPERIMENT_EVENTS as readonly unknown[]).includes(event);
}

// The site setting: comma-separated "id:weight" entries, such as
// "default:2, math:1, project:1". A bare id has weight 1. Unknown ids,
// duplicates and non-positive weights are dropped. Fewer than two arms means
// the experiment is off.
export function parsePublicHomeExperimentArms(
  value: unknown,
  known: readonly string[] = PUBLIC_HOME_VARIANTS,
): PublicHomeExperimentArm[] {
  if (typeof value !== "string") return [];
  const arms: PublicHomeExperimentArm[] = [];
  for (const entry of value.split(",")) {
    const [rawId, rawWeight] = entry.split(":").map((s) => s.trim());
    if (!rawId) continue;
    const weight =
      rawWeight == null || rawWeight === "" ? 1 : Number(rawWeight);
    if (!isPublicHomeVariantId(rawId, known)) continue;
    if (!Number.isFinite(weight) || weight <= 0) continue;
    if (arms.some((arm) => arm.id === rawId)) continue;
    arms.push({ id: rawId, weight });
  }
  return arms.length >= 2 ? arms : [];
}

// Pick an arm in proportion to its weight. `random` is in [0, 1).
export function pickPublicHomeVariant(
  arms: readonly PublicHomeExperimentArm[],
  random: number,
): string {
  if (arms.length === 0) return PUBLIC_HOME_DEFAULT_VARIANT;
  const total = arms.reduce((sum, arm) => sum + arm.weight, 0);
  let point = Math.min(Math.max(random, 0), 0.999999999) * total;
  for (const arm of arms) {
    if (point < arm.weight) return arm.id;
    point -= arm.weight;
  }
  return arms[arms.length - 1].id;
}

// Add the version to a sign-up link, keeping any existing query.
export function withPublicHomeVariant(href: string, variant: string): string {
  const [path, hash] = href.split("#", 2);
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}${PUBLIC_HOME_VARIANT_PARAM}=${encodeURIComponent(variant)}${hash != null ? `#${hash}` : ""}`;
}
