/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Where and when the person is, for agent turns: agents otherwise assume UTC,
// so "today", "tonight" and "6am" mean the wrong thing.

/** Account setting: include approximate location (city, region) for agents.
 * On unless set to false; the time zone is always included. */
export const OTHER_SETTINGS_AGENT_LOCATION_KEY = "agent_location_metadata";

export interface AgentUserLocale {
  /** IANA time zone, e.g. America/Los_Angeles. */
  time_zone?: string;
  city?: string;
  region?: string;
  /** ISO 3166-1 alpha-2, e.g. US. */
  country_code?: string;
}

const MAX_PLACE_LENGTH = 80;

export function agentLocationEnabled(setting: unknown): boolean {
  return setting !== false;
}

function validTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const zone = value.trim();
  if (!zone || zone.length > 64) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

// Place names go into the agent's prompt: one short line of name characters.
function validPlace(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value))
    return undefined;
  const place = value.replace(/ +/g, " ").trim();
  if (!place || place.length > MAX_PLACE_LENGTH) return undefined;
  return /^[\p{L}\p{M}\p{N} .,'()-]+$/u.test(place) ? place : undefined;
}

function validCountry(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim().toUpperCase();
  // XX: unknown; T1: Tor (Cloudflare).
  return /^[A-Z]{2}$/.test(code) && code !== "XX" ? code : undefined;
}

export function normalizeAgentUserLocale(
  raw: unknown,
): AgentUserLocale | undefined {
  if (raw == null || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const locale: AgentUserLocale = {};
  const time_zone = validTimeZone(value.time_zone);
  const city = validPlace(value.city);
  const region = validPlace(value.region);
  const country_code = validCountry(value.country_code);
  if (time_zone) locale.time_zone = time_zone;
  if (city) locale.city = city;
  if (region) locale.region = region;
  if (country_code) locale.country_code = country_code;
  return Object.keys(locale).length > 0 ? locale : undefined;
}

/** One line for the agent's turn context, or undefined without a time zone. */
export function formatAgentUserTimeContext(
  locale: AgentUserLocale | undefined,
  now: Date = new Date(),
): string | undefined {
  const normalized = normalizeAgentUserLocale(locale);
  const time_zone = normalized?.time_zone;
  if (!time_zone) return undefined;
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: time_zone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(now);
  const place = [normalized.city, normalized.region, normalized.country_code]
    .filter(Boolean)
    .join(", ");
  return [
    `The user's local time is ${when} (${time_zone}).`,
    place ? `The user is near ${place}.` : "",
    "Read dates and times the user mentions (today, tonight, 6am) in this time zone, and give times with their zone.",
  ]
    .filter(Boolean)
    .join(" ");
}
