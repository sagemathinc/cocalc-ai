/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const R2_REGIONS = [
  "wnam",
  "enam",
  "weur",
  "eeur",
  "apac",
  "oc",
] as const;

export type R2Region = (typeof R2_REGIONS)[number];

export const DEFAULT_R2_REGION: R2Region = "wnam";

export const R2_REGION_LABELS: Record<R2Region, string> = {
  wnam: "Western North America",
  enam: "Eastern North America",
  weur: "Western Europe",
  eeur: "Eastern Europe",
  apac: "Asia-Pacific",
  oc: "Oceania",
};

const WESTERN_US_REGION_CODES = new Set([
  "AK",
  "AZ",
  "CA",
  "CO",
  "HI",
  "ID",
  "MT",
  "NM",
  "NV",
  "OR",
  "UT",
  "WA",
  "WY",
]);

const EASTERN_CA_REGION_CODES = new Set(["ON", "QC", "NB", "NS", "PE", "NL"]);

const OCEANIA_COUNTRIES = new Set(["AU", "NZ"]);
const APAC_COUNTRIES = new Set([
  "AE",
  "BD",
  "BN",
  "CN",
  "HK",
  "ID",
  "IL",
  "IN",
  "IQ",
  "IR",
  "JP",
  "JO",
  "KH",
  "KR",
  "KW",
  "LA",
  "LB",
  "LK",
  "MM",
  "MN",
  "MO",
  "MY",
  "NP",
  "OM",
  "PH",
  "PK",
  "PS",
  "QA",
  "SA",
  "SG",
  "SY",
  "TH",
  "TL",
  "TR",
  "TW",
  "VN",
  "YE",
]);
const EASTERN_EUROPE_COUNTRIES = new Set([
  "AL",
  "AM",
  "AZ",
  "BA",
  "BG",
  "BY",
  "CZ",
  "EE",
  "FI",
  "GE",
  "GR",
  "HR",
  "HU",
  "LT",
  "LV",
  "MD",
  "ME",
  "MK",
  "PL",
  "RO",
  "RS",
  "RU",
  "SI",
  "SK",
  "UA",
]);
const WESTERN_EUROPE_COUNTRIES = new Set([
  "AD",
  "AT",
  "BE",
  "CH",
  "DE",
  "DK",
  "ES",
  "FR",
  "GB",
  "IE",
  "IS",
  "IT",
  "LI",
  "LU",
  "MC",
  "MT",
  "NL",
  "NO",
  "PT",
  "SE",
  "SM",
  "VA",
]);
const EASTERN_NORTH_AMERICA_COUNTRIES = new Set([
  "BR",
  "CA",
  "CL",
  "CO",
  "MX",
  "PE",
  "US",
  "UY",
  "VE",
  "AR",
  "BO",
  "CR",
  "DO",
  "EC",
  "GT",
  "HN",
  "NI",
  "PA",
  "PR",
  "PY",
  "SV",
]);

const R2_REGION_PROXIMITY: Record<R2Region, R2Region[]> = {
  wnam: ["wnam", "enam", "weur", "eeur", "apac", "oc"],
  enam: ["enam", "wnam", "weur", "eeur", "apac", "oc"],
  weur: ["weur", "eeur", "enam", "wnam", "apac", "oc"],
  eeur: ["eeur", "weur", "apac", "enam", "wnam", "oc"],
  apac: ["apac", "oc", "eeur", "weur", "wnam", "enam"],
  oc: ["oc", "apac", "wnam", "enam", "weur", "eeur"],
};

export function parseR2Region(value?: string | null): R2Region | undefined {
  if (!value) return;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return;
  if ((R2_REGIONS as readonly string[]).includes(normalized)) {
    return normalized as R2Region;
  }
  return;
}

export function mapCloudRegionToR2Region(
  region?: string | null,
): R2Region {
  const normalized = (region ?? "").trim().toLowerCase();
  if (!normalized) return DEFAULT_R2_REGION;
  const direct = parseR2Region(normalized);
  if (direct) return direct;
  if (normalized.startsWith("africa-") || normalized.includes("africa")) {
    return "weur";
  }
  if (/^europe-central2/.test(normalized) || normalized.includes("europe-east")) {
    return "eeur";
  }
  if (
    normalized.startsWith("europe-") ||
    normalized.startsWith("eu-") ||
    normalized.includes("norway")
  ) {
    return "weur";
  }
  if (normalized.startsWith("northamerica-") || normalized.includes("canada")) {
    return "enam";
  }
  if (normalized.startsWith("southamerica-")) {
    return "enam";
  }
  if (/^us-(west|south)/.test(normalized)) {
    return "wnam";
  }
  if (/^us-(east|central|north)/.test(normalized) || normalized.startsWith("us-")) {
    return "enam";
  }
  if (normalized.startsWith("me-")) {
    return "eeur";
  }
  if (
    normalized.startsWith("ap-") ||
    normalized.startsWith("asia") ||
    normalized.includes("apac")
  ) {
    return "apac";
  }
  if (normalized.startsWith("oc") || normalized.includes("australia")) {
    return "oc";
  }
  return DEFAULT_R2_REGION;
}

export function mapCountryRegionToR2Region(
  country?: string | null,
  regionCode?: string | null,
): R2Region {
  const normalizedCountry = `${country ?? ""}`.trim().toUpperCase();
  const normalizedRegion = `${regionCode ?? ""}`.trim().toUpperCase();

  if (normalizedCountry === "US") {
    return WESTERN_US_REGION_CODES.has(normalizedRegion) ? "wnam" : "enam";
  }
  if (normalizedCountry === "CA") {
    return EASTERN_CA_REGION_CODES.has(normalizedRegion) ? "enam" : "wnam";
  }
  if (normalizedCountry === "K1" || normalizedCountry === "XX") {
    return DEFAULT_R2_REGION;
  }
  if (OCEANIA_COUNTRIES.has(normalizedCountry)) return "oc";
  if (APAC_COUNTRIES.has(normalizedCountry)) return "apac";
  if (EASTERN_EUROPE_COUNTRIES.has(normalizedCountry)) return "eeur";
  if (WESTERN_EUROPE_COUNTRIES.has(normalizedCountry)) return "weur";
  if (EASTERN_NORTH_AMERICA_COUNTRIES.has(normalizedCountry)) return "enam";
  if (normalizedCountry.length === 2) {
    // For unmapped countries default to Western Europe, which is usually
    // closer than NA for Africa and many edge cases.
    return "weur";
  }
  return DEFAULT_R2_REGION;
}

export function rankR2RegionDistance(
  from: R2Region | undefined,
  to: R2Region | undefined,
): number {
  if (!from || !to) return Number.MAX_SAFE_INTEGER;
  const order = R2_REGION_PROXIMITY[from] ?? [];
  const idx = order.indexOf(to);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}
