/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import type {
  ActiveUserMapBayReport,
  ActiveUserMapCountry,
  ActiveUserMapCountryReport,
  ActiveUserMapDetails,
  ActiveUserMapDetailsQuery,
  ActiveUserMapEmailDomainCount,
  ActiveUserMapGrouping,
  ActiveUserMapOverview,
  ActiveUserMapQuery,
  ActiveUserMapUser,
  ActiveUserMapWindowMinutes,
  BrowserSessionLocation,
} from "@cocalc/conat/hub/api/system";
import { displayNameFromAccount } from "@cocalc/util/accounts/display-name";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { listConfiguredBays } from "@cocalc/server/bay-directory";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";

const logger = getLogger("server:account-presence-locations");
const LOCATION_TTL_HOURS = 26;
const WRITE_THROTTLE_MS = 5 * 60_000;
const VALID_WINDOWS = new Set<number>([5, 15, 60, 1440]);
const MIN_DOMAIN_PERCENT = 1.5;
const UNKNOWN_DOMAIN = "Unknown";
const lastWriteByAccount = new Map<string, number>();

type LocationGroupDescriptor = Pick<
  ActiveUserMapCountry,
  | "group_id"
  | "granularity"
  | "country_code"
  | "region_code"
  | "region"
  | "city"
>;

type NormalizedLocation = {
  country_code: string;
  region_code: string | null;
  region: string | null;
  city: string | null;
  continent: string | null;
  timezone: string | null;
  latitude: number;
  longitude: number;
};

type ActiveLocationRow = {
  account_id: string;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email_address: string | null;
  last_active: Date | string;
  country_code: string | null;
  region_code: string | null;
  region: string | null;
  city: string | null;
  timezone: string | null;
  latitude: number | string | null;
  longitude: number | string | null;
};

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  let text = value.trim();
  if (!text) return null;
  try {
    text = decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    // Keep the original header value if it was not valid URI encoding.
  }
  text = text.trim();
  return text ? text.slice(0, maxLength) : null;
}

function coordinate(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

export function normalizeAccountPresenceLocation(
  value: BrowserSessionLocation | undefined,
): NormalizedLocation | undefined {
  const countryCode = cleanText(value?.country_code, 2)?.toUpperCase();
  if (
    !countryCode ||
    !/^[A-Z0-9]{2}$/.test(countryCode) ||
    countryCode === "XX" ||
    countryCode === "K1"
  ) {
    return undefined;
  }
  const latitude = coordinate(value?.latitude, -90, 90);
  const longitude = coordinate(value?.longitude, -180, 180);
  if (latitude == null || longitude == null) return undefined;
  return {
    country_code: countryCode,
    region_code: cleanText(value?.region_code, 16),
    region: cleanText(value?.region, 128),
    city: cleanText(value?.city, 128),
    continent: cleanText(value?.continent, 8),
    timezone: cleanText(value?.timezone, 64),
    latitude,
    longitude,
  };
}

async function activeUserMapEnabled(): Promise<boolean> {
  return (await getServerSettings()).active_user_map_enabled === true;
}

export async function recordAccountPresenceLocation({
  account_id,
  location,
}: {
  account_id: string;
  location?: BrowserSessionLocation;
}): Promise<boolean> {
  try {
    if (!(await activeUserMapEnabled())) return false;
    const normalized = normalizeAccountPresenceLocation(location);
    if (!normalized) return false;
    const now = Date.now();
    const previous = lastWriteByAccount.get(account_id) ?? 0;
    if (now - previous < WRITE_THROTTLE_MS) return false;
    lastWriteByAccount.set(account_id, now);
    await getPool().query(
      `INSERT INTO account_presence_locations
         (account_id, bay_id, observed_at, expire, country_code, region_code,
          region, city, continent, timezone, latitude, longitude)
       VALUES
         ($1, $2, NOW(), NOW() + ($3 * INTERVAL '1 hour'), $4, $5, $6, $7,
          $8, $9, $10, $11)
       ON CONFLICT (account_id) DO UPDATE SET
         bay_id = EXCLUDED.bay_id,
         observed_at = EXCLUDED.observed_at,
         expire = EXCLUDED.expire,
         country_code = EXCLUDED.country_code,
         region_code = EXCLUDED.region_code,
         region = EXCLUDED.region,
         city = EXCLUDED.city,
         continent = EXCLUDED.continent,
         timezone = EXCLUDED.timezone,
         latitude = EXCLUDED.latitude,
         longitude = EXCLUDED.longitude
       WHERE account_presence_locations.observed_at <= EXCLUDED.observed_at`,
      [
        account_id,
        getConfiguredBayId(),
        LOCATION_TTL_HOURS,
        normalized.country_code,
        normalized.region_code,
        normalized.region,
        normalized.city,
        normalized.continent,
        normalized.timezone,
        normalized.latitude,
        normalized.longitude,
      ],
    );
    return true;
  } catch {
    lastWriteByAccount.delete(account_id);
    logger.debug("location upsert failed", {
      code: "account_presence_location_upsert_failed",
    });
    return false;
  }
}

function normalizeWindow(value: number): ActiveUserMapWindowMinutes {
  if (!VALID_WINDOWS.has(value)) {
    throw Error("active_minutes must be one of 5, 15, 60, or 1440");
  }
  return value as ActiveUserMapWindowMinutes;
}

function normalizeGrouping(
  value: ActiveUserMapGrouping | undefined,
): ActiveUserMapGrouping {
  if (value == null) return "country";
  if (value !== "country" && value !== "region" && value !== "city") {
    throw Error("group_by must be country, region, or city");
  }
  return value;
}

function groupKeyPart(value: string | null | undefined): string {
  return `${value ?? ""}`.trim().toLowerCase();
}

function locationGroupDescriptor(
  row: ActiveLocationRow,
  grouping: ActiveUserMapGrouping,
): LocationGroupDescriptor {
  const country_code = row.country_code!;
  if (grouping === "city" && row.city) {
    const regionKey = row.region_code ?? row.region;
    return {
      group_id: [
        "city",
        groupKeyPart(country_code),
        groupKeyPart(regionKey),
        groupKeyPart(row.city),
      ].join(":"),
      granularity: "city",
      country_code,
      region_code: row.region_code,
      region: row.region,
      city: row.city,
    };
  }
  if (
    (grouping === "region" || grouping === "city") &&
    (row.region_code || row.region)
  ) {
    return {
      group_id: [
        "region",
        groupKeyPart(country_code),
        groupKeyPart(row.region_code ?? row.region),
      ].join(":"),
      granularity: "region",
      country_code,
      region_code: row.region_code,
      region: row.region,
      city: null,
    };
  }
  return {
    group_id: country_code,
    granularity: "country",
    country_code,
    region_code: null,
    region: null,
    city: null,
  };
}

function normalizedGroupDescriptor(
  group: ActiveUserMapCountry,
): LocationGroupDescriptor {
  return {
    group_id: group.group_id ?? group.country_code,
    granularity: group.granularity ?? "country",
    country_code: group.country_code,
    region_code: group.region_code ?? null,
    region: group.region ?? null,
    city: group.city ?? null,
  };
}

function mapUser(row: ActiveLocationRow, bay_id: string): ActiveUserMapUser {
  return {
    account_id: row.account_id,
    bay_id,
    display_name: row.display_name,
    first_name: row.first_name,
    last_name: row.last_name,
    email_address: row.email_address,
    last_active: new Date(row.last_active).toISOString(),
    region_code: row.region_code,
    region: row.region,
    city: row.city,
    timezone: row.timezone,
  };
}

export async function getActiveUserMapReport({
  active_minutes,
  group_by,
}: {
  active_minutes: number;
  group_by?: ActiveUserMapGrouping;
}): Promise<ActiveUserMapBayReport> {
  const windowMinutes = normalizeWindow(active_minutes);
  const grouping = normalizeGrouping(group_by);
  const checked_at = new Date().toISOString();
  const bay_id = getConfiguredBayId();
  if (!(await activeUserMapEnabled())) {
    return {
      enabled: false,
      checked_at,
      bay_id,
      current_bay_id: bay_id,
      active_minutes: windowMinutes,
      total_active: 0,
      mapped_active: 0,
      unknown_location: 0,
      countries: [],
      unknown_users: [],
      bays: [{ bay_id, ok: true, enabled: false, total_active: 0 }],
    };
  }
  const { rows } = await getPool().query<ActiveLocationRow>(
    `SELECT a.account_id, a.display_name, a.first_name, a.last_name,
            a.email_address, a.last_active,
            p.country_code, p.region_code, p.region, p.city, p.timezone,
            p.latitude, p.longitude
       FROM accounts a
       LEFT JOIN account_presence_locations p
         ON p.account_id = a.account_id AND p.expire > NOW()
      WHERE a.last_active >= NOW() - ($1 * INTERVAL '1 minute')
      ORDER BY a.last_active DESC`,
    [windowMinutes],
  );

  const groups = new Map<
    string,
    ActiveUserMapCountryReport & {
      latitudeSum: number;
      longitudeSum: number;
    }
  >();
  const unknown_users: ActiveUserMapUser[] = [];
  for (const row of rows) {
    const user = mapUser(row, bay_id);
    const latitude = Number(row.latitude);
    const longitude = Number(row.longitude);
    if (
      !row.country_code ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      unknown_users.push(user);
      continue;
    }
    const descriptor = locationGroupDescriptor(row, grouping);
    const current = groups.get(descriptor.group_id!) ?? {
      ...descriptor,
      count: 0,
      latitude: 0,
      longitude: 0,
      latitudeSum: 0,
      longitudeSum: 0,
      users: [],
    };
    current.count += 1;
    current.latitudeSum += latitude;
    current.longitudeSum += longitude;
    current.users.push(user);
    groups.set(descriptor.group_id!, current);
  }
  const mappedCountries = [...groups.values()]
    .map(({ latitudeSum, longitudeSum, ...country }) => ({
      ...country,
      latitude: latitudeSum / country.count,
      longitude: longitudeSum / country.count,
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        (a.group_id ?? a.country_code).localeCompare(
          b.group_id ?? b.country_code,
        ),
    );
  const mapped_active = mappedCountries.reduce(
    (total, country) => total + country.count,
    0,
  );
  return {
    enabled: true,
    checked_at,
    bay_id,
    current_bay_id: bay_id,
    active_minutes: windowMinutes,
    total_active: rows.length,
    mapped_active,
    unknown_location: unknown_users.length,
    countries: mappedCountries,
    unknown_users,
    bays: [
      {
        bay_id,
        ok: true,
        enabled: true,
        total_active: rows.length,
      },
    ],
  };
}

type AggregateUser = {
  user: ActiveUserMapUser;
  group?: LocationGroupDescriptor;
  latitude?: number;
  longitude?: number;
};

function shouldReplaceAggregateUser(
  current: AggregateUser | undefined,
  candidate: AggregateUser,
): boolean {
  if (!current) return true;
  const currentTime = new Date(current.user.last_active).valueOf();
  const candidateTime = new Date(candidate.user.last_active).valueOf();
  return (
    candidateTime > currentTime ||
    (candidateTime === currentTime &&
      candidate.group != null &&
      current.group == null)
  );
}

function aggregateActiveUserMapReports({
  reports,
  active_minutes,
  current_bay_id,
  bays,
}: {
  reports: ActiveUserMapBayReport[];
  active_minutes: ActiveUserMapWindowMinutes;
  current_bay_id: string;
  bays: ActiveUserMapOverview["bays"];
}): ActiveUserMapBayReport {
  const usersByAccount = new Map<string, AggregateUser>();
  for (const report of reports) {
    for (const country of report.countries) {
      for (const user of country.users) {
        const candidate: AggregateUser = {
          user,
          group: normalizedGroupDescriptor(country),
          latitude: country.latitude,
          longitude: country.longitude,
        };
        if (
          shouldReplaceAggregateUser(
            usersByAccount.get(user.account_id),
            candidate,
          )
        ) {
          usersByAccount.set(user.account_id, candidate);
        }
      }
    }
    for (const user of report.unknown_users) {
      const candidate: AggregateUser = { user };
      if (
        shouldReplaceAggregateUser(
          usersByAccount.get(user.account_id),
          candidate,
        )
      ) {
        usersByAccount.set(user.account_id, candidate);
      }
    }
  }

  const groups = new Map<
    string,
    ActiveUserMapCountryReport & {
      latitudeSum: number;
      longitudeSum: number;
    }
  >();
  const unknown_users: ActiveUserMapUser[] = [];
  for (const entry of usersByAccount.values()) {
    if (!entry.group || entry.latitude == null || entry.longitude == null) {
      unknown_users.push(entry.user);
      continue;
    }
    const group = groups.get(entry.group.group_id!) ?? {
      ...entry.group,
      count: 0,
      latitude: 0,
      longitude: 0,
      latitudeSum: 0,
      longitudeSum: 0,
      users: [],
    };
    group.count += 1;
    group.latitudeSum += entry.latitude;
    group.longitudeSum += entry.longitude;
    group.users.push(entry.user);
    groups.set(entry.group.group_id!, group);
  }
  const byLastActive = (a: ActiveUserMapUser, b: ActiveUserMapUser) =>
    new Date(b.last_active).valueOf() - new Date(a.last_active).valueOf();
  unknown_users.sort(byLastActive);
  const mappedCountries = [...groups.values()]
    .map(({ latitudeSum, longitudeSum, ...country }) => ({
      ...country,
      latitude: latitudeSum / country.count,
      longitude: longitudeSum / country.count,
      users: country.users.sort(byLastActive),
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        (a.group_id ?? a.country_code).localeCompare(
          b.group_id ?? b.country_code,
        ),
    );
  const mapped_active = mappedCountries.reduce(
    (total, country) => total + country.count,
    0,
  );
  return {
    enabled: reports.some((report) => report.enabled),
    checked_at: new Date().toISOString(),
    bay_id: reports.length === 1 ? reports[0].bay_id : "all",
    current_bay_id,
    active_minutes,
    total_active: usersByAccount.size,
    mapped_active,
    unknown_location: unknown_users.length,
    countries: mappedCountries,
    unknown_users,
    bays,
  };
}

export async function getActiveUserMapOverviewAcrossBays({
  account_id,
  active_minutes,
  group_by,
}: ActiveUserMapQuery): Promise<ActiveUserMapOverview> {
  const report = await getActiveUserMapReportAcrossBays({
    account_id,
    active_minutes,
    group_by,
  });
  return {
    enabled: report.enabled,
    checked_at: report.checked_at,
    bay_id: report.bay_id,
    current_bay_id: report.current_bay_id,
    active_minutes: report.active_minutes,
    total_active: report.total_active,
    mapped_active: report.mapped_active,
    unknown_location: report.unknown_location,
    countries: report.countries.map((country) => ({
      group_id: country.group_id,
      granularity: country.granularity,
      country_code: country.country_code,
      region_code: country.region_code,
      region: country.region,
      city: country.city,
      latitude: country.latitude,
      longitude: country.longitude,
      count: country.count,
    })),
    bays: report.bays,
  };
}

async function getActiveUserMapReportAcrossBays({
  account_id,
  active_minutes,
  group_by,
}: ActiveUserMapQuery): Promise<ActiveUserMapBayReport> {
  const windowMinutes = normalizeWindow(active_minutes);
  const grouping = normalizeGrouping(group_by);
  const currentBayId = getConfiguredBayId();
  const bayIds = [
    ...new Set(
      (await listConfiguredBays())
        .map(({ bay_id }) => `${bay_id ?? ""}`.trim())
        .filter(Boolean)
        .concat(currentBayId),
    ),
  ].sort();
  const settled = await Promise.allSettled(
    bayIds.map(async (bay_id) =>
      bay_id === currentBayId
        ? await getActiveUserMapReport({
            active_minutes: windowMinutes,
            group_by: grouping,
          })
        : await getInterBayBridge()
            .bayOps(bay_id, { timeout_ms: 10_000 })
            .getActiveUserMap({
              account_id,
              active_minutes: windowMinutes,
              group_by: grouping,
            }),
    ),
  );
  const reports: ActiveUserMapBayReport[] = [];
  const bays: ActiveUserMapOverview["bays"] = bayIds.map((bay_id, index) => {
    const result = settled[index];
    if (result.status === "fulfilled") {
      reports.push(result.value);
      return {
        bay_id,
        ok: true,
        enabled: result.value.enabled,
        total_active: result.value.total_active,
      };
    }
    return { bay_id, ok: false, error: `${result.reason}` };
  });
  if (reports.length === 0) {
    throw Error("active user map is unavailable on every configured bay");
  }
  return aggregateActiveUserMapReports({
    reports,
    active_minutes: windowMinutes,
    current_bay_id: currentBayId,
    bays,
  });
}

function compareUsersByActivity(
  left: ActiveUserMapUser,
  right: ActiveUserMapUser,
): number {
  return (
    new Date(right.last_active).valueOf() -
      new Date(left.last_active).valueOf() ||
    left.account_id.localeCompare(right.account_id)
  );
}

function emailDomain(email?: string | null): string {
  const normalized = email?.trim().toLowerCase() ?? "";
  const separator = normalized.lastIndexOf("@");
  if (
    separator <= 0 ||
    separator === normalized.length - 1 ||
    normalized.slice(separator + 1).includes(" ")
  ) {
    return UNKNOWN_DOMAIN;
  }
  return normalized.slice(separator + 1);
}

export function activeUserMapEmailDomainCounts(
  users: ActiveUserMapUser[],
): ActiveUserMapEmailDomainCount[] {
  const totals = new Map<string, number>();
  for (const user of users) {
    const domain = emailDomain(user.email_address);
    totals.set(domain, (totals.get(domain) ?? 0) + 1);
  }
  const total = users.length;
  const visible: ActiveUserMapEmailDomainCount[] = [];
  let other = 0;
  for (const [domain, count] of [...totals].sort(
    ([leftDomain, leftCount], [rightDomain, rightCount]) =>
      rightCount - leftCount || leftDomain.localeCompare(rightDomain),
  )) {
    if (count * 100 >= total * MIN_DOMAIN_PERCENT) {
      visible.push({ domain, count });
    } else {
      other += count;
    }
  }
  if (other > 0) visible.push({ domain: "Other", count: other });
  return visible;
}

function usersForDetailScope(
  report: ActiveUserMapBayReport,
  query: ActiveUserMapDetailsQuery,
): ActiveUserMapUser[] {
  if (query.scope === "unknown") return [...report.unknown_users];
  if (query.scope === "all") {
    return [
      ...report.countries.flatMap(({ users }) => users),
      ...report.unknown_users,
    ];
  }
  if (query.scope !== "group") {
    throw Error("scope must be all, group, or unknown");
  }
  if (!query.group_id) throw Error("group_id is required for group details");
  return [
    ...(report.countries.find(
      ({ group_id, country_code }) =>
        (group_id ?? country_code) === query.group_id,
    )?.users ?? []),
  ];
}

export async function getActiveUserMapDetailsAcrossBays(
  query: ActiveUserMapDetailsQuery,
): Promise<ActiveUserMapDetails> {
  const report = await getActiveUserMapReportAcrossBays(query);
  const allUsers = usersForDetailScope(report, query).sort(
    compareUsersByActivity,
  );
  return {
    checked_at: report.checked_at,
    total: allUsers.length,
    users: allUsers.map(
      ({
        account_id,
        bay_id,
        city,
        display_name,
        email_address,
        first_name,
        last_active,
        last_name,
        region,
        region_code,
      }) => ({
        account_id,
        bay_id,
        city,
        email_address,
        last_active,
        name:
          displayNameFromAccount({ display_name, first_name, last_name }) ||
          email_address ||
          account_id,
        region,
        region_code,
      }),
    ),
    domain_counts: activeUserMapEmailDomainCounts(allUsers),
    bays: report.bays,
  };
}

export function clearAccountPresenceLocationThrottleForTesting(): void {
  lastWriteByAccount.clear();
}
