/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ActiveUserMapUser } from "@cocalc/conat/hub/api/system";

let getServerSettingsMock: jest.Mock;
let queryMock: jest.Mock;
let listConfiguredBaysMock: jest.Mock;
let getRemoteActiveUserMapMock: jest.Mock;

function activeMapUser(
  account_id: string,
  email_address?: string,
): ActiveUserMapUser {
  return {
    account_id,
    bay_id: "bay-1",
    display_name: null,
    first_name: null,
    last_name: null,
    email_address: email_address ?? null,
    last_active: "2026-07-14T10:00:00.000Z",
    region_code: null,
    region: null,
    city: null,
    timezone: null,
  };
}

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-1",
}));

jest.mock("@cocalc/server/bay-directory", () => ({
  listConfiguredBays: (...args: any[]) => listConfiguredBaysMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: () => ({
    bayOps: (bay_id: string, opts: unknown) => ({
      getActiveUserMap: (query: unknown) =>
        getRemoteActiveUserMapMock(bay_id, opts, query),
    }),
  }),
}));

describe("account presence locations", () => {
  beforeEach(() => {
    jest.resetModules();
    getServerSettingsMock = jest.fn(async () => ({
      active_user_map_enabled: true,
    }));
    queryMock = jest.fn(async () => ({ rows: [] }));
    listConfiguredBaysMock = jest.fn(async () => [{ bay_id: "bay-1" }]);
    getRemoteActiveUserMapMock = jest.fn();
  });

  it("normalizes approximate Cloudflare location fields", async () => {
    const { normalizeAccountPresenceLocation } =
      await import("./account-presence-locations");
    expect(
      normalizeAccountPresenceLocation({
        country_code: " us ",
        region_code: "WA",
        region: "Washington",
        city: "Seattle%20City",
        continent: "NA",
        timezone: "America/Los_Angeles",
        latitude: "47.61",
        longitude: "-122.33",
      }),
    ).toEqual({
      country_code: "US",
      region_code: "WA",
      region: "Washington",
      city: "Seattle City",
      continent: "NA",
      timezone: "America/Los_Angeles",
      latitude: 47.61,
      longitude: -122.33,
    });
    expect(
      normalizeAccountPresenceLocation({
        country_code: "XX",
        latitude: "0",
        longitude: "0",
      }),
    ).toBeUndefined();
  });

  it("normalizes email domains and combines shares below 1.5 percent", async () => {
    const { activeUserMapEmailDomainCounts } =
      await import("./account-presence-locations");
    const users = [
      ...Array.from({ length: 193 }, (_, index) =>
        activeMapUser(`major-${index}`, `user-${index}@major.test`),
      ),
      activeMapUser("exact-1", "one@EXACT.test"),
      activeMapUser("exact-2", "two@exact.test"),
      activeMapUser("exact-3", "three@exact.test"),
      activeMapUser("small-1", "user@small-1.test"),
      activeMapUser("small-2", "user@small-2.test"),
      activeMapUser("small-3"),
      activeMapUser("small-4", "invalid"),
    ];

    expect(activeUserMapEmailDomainCounts(users)).toEqual([
      { domain: "major.test", count: 193 },
      { domain: "exact.test", count: 3 },
      { domain: "Other", count: 4 },
    ]);
  });

  it("writes one expiring location and throttles repeated heartbeats", async () => {
    const { recordAccountPresenceLocation } =
      await import("./account-presence-locations");
    const location = {
      country_code: "US",
      latitude: "47.61",
      longitude: "-122.33",
    };
    await expect(
      recordAccountPresenceLocation({ account_id: "account-1", location }),
    ).resolves.toBe(true);
    await expect(
      recordAccountPresenceLocation({ account_id: "account-1", location }),
    ).resolves.toBe(false);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0]).toContain(
      "ON CONFLICT (account_id) DO UPDATE",
    );
    expect(queryMock.mock.calls[0][1]).toEqual([
      "account-1",
      "bay-1",
      26,
      "US",
      null,
      null,
      null,
      null,
      null,
      47.61,
      -122.33,
    ]);
  });

  it("does not collect location when the site setting is disabled", async () => {
    getServerSettingsMock.mockResolvedValue({
      active_user_map_enabled: false,
    });
    const { recordAccountPresenceLocation } =
      await import("./account-presence-locations");
    await expect(
      recordAccountPresenceLocation({
        account_id: "account-1",
        location: {
          country_code: "US",
          latitude: "47.61",
          longitude: "-122.33",
        },
      }),
    ).resolves.toBe(false);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("groups a one-day active-user query and keeps unknown users separate", async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          account_id: "account-1",
          display_name: "Ada",
          first_name: "Ada",
          last_name: "Lovelace",
          email_address: "ada@example.com",
          last_active: "2026-07-14T10:00:00.000Z",
          country_code: "GB",
          region_code: "ENG",
          region: "England",
          city: "London",
          timezone: "Europe/London",
          latitude: "51.5",
          longitude: "-0.12",
        },
        {
          account_id: "account-2",
          display_name: "Unknown",
          first_name: null,
          last_name: null,
          email_address: "unknown@example.com",
          last_active: "2026-07-14T09:00:00.000Z",
          country_code: null,
          region_code: null,
          region: null,
          city: null,
          timezone: null,
          latitude: null,
          longitude: null,
        },
      ],
    });
    const { getActiveUserMapReport } =
      await import("./account-presence-locations");
    const result = await getActiveUserMapReport({ active_minutes: 1440 });
    expect(queryMock.mock.calls[0][1]).toEqual([1440]);
    expect(result).toMatchObject({
      enabled: true,
      bay_id: "bay-1",
      current_bay_id: "bay-1",
      active_minutes: 1440,
      total_active: 2,
      mapped_active: 1,
      unknown_location: 1,
      countries: [
        {
          country_code: "GB",
          count: 1,
          latitude: 51.5,
          longitude: -0.12,
        },
      ],
    });
    expect(result.unknown_users.map(({ account_id }) => account_id)).toEqual([
      "account-2",
    ]);
    expect(result.countries[0].users[0].bay_id).toBe("bay-1");
  });

  it("groups live users by region or city with regional fallback", async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          account_id: "account-1",
          display_name: "Ada",
          first_name: "Ada",
          last_name: "Lovelace",
          email_address: "ada@example.com",
          last_active: "2026-07-14T10:00:00.000Z",
          country_code: "CA",
          region_code: "AB",
          region: "Alberta",
          city: "Calgary",
          timezone: "America/Edmonton",
          latitude: "51.04",
          longitude: "-114.07",
        },
        {
          account_id: "account-2",
          display_name: "Grace",
          first_name: "Grace",
          last_name: "Hopper",
          email_address: "grace@example.com",
          last_active: "2026-07-14T09:00:00.000Z",
          country_code: "CA",
          region_code: "AB",
          region: "Alberta",
          city: "calgary",
          timezone: "America/Edmonton",
          latitude: "51.06",
          longitude: "-114.09",
        },
        {
          account_id: "account-3",
          display_name: "Katherine",
          first_name: "Katherine",
          last_name: "Johnson",
          email_address: "katherine@example.com",
          last_active: "2026-07-14T08:00:00.000Z",
          country_code: "CA",
          region_code: "BC",
          region: "British Columbia",
          city: null,
          timezone: "America/Vancouver",
          latitude: "53.73",
          longitude: "-127.65",
        },
      ],
    });
    const { getActiveUserMapReport } =
      await import("./account-presence-locations");
    const result = await getActiveUserMapReport({
      active_minutes: 60,
      group_by: "city",
    });

    expect(result.countries).toEqual([
      expect.objectContaining({
        group_id: "city:ca:ab:calgary",
        granularity: "city",
        country_code: "CA",
        region_code: "AB",
        region: "Alberta",
        city: "Calgary",
        count: 2,
        latitude: 51.05,
        longitude: -114.08,
      }),
      expect.objectContaining({
        group_id: "region:ca:bc",
        granularity: "region",
        country_code: "CA",
        region_code: "BC",
        region: "British Columbia",
        city: null,
        count: 1,
      }),
    ]);

    const regional = await getActiveUserMapReport({
      active_minutes: 60,
      group_by: "region",
    });
    expect(regional.countries).toEqual([
      expect.objectContaining({
        group_id: "region:ca:ab",
        granularity: "region",
        country_code: "CA",
        region_code: "AB",
        region: "Alberta",
        city: null,
        count: 2,
        latitude: 51.05,
        longitude: -114.08,
      }),
      expect.objectContaining({
        group_id: "region:ca:bc",
        granularity: "region",
        country_code: "CA",
        region_code: "BC",
        region: "British Columbia",
        city: null,
        count: 1,
      }),
    ]);
  });

  it("aggregates configured bays and keeps the newest account activity", async () => {
    listConfiguredBaysMock.mockResolvedValue([
      { bay_id: "bay-1" },
      { bay_id: "bay-2" },
    ]);
    queryMock.mockResolvedValue({
      rows: [
        {
          account_id: "account-1",
          display_name: "Ada",
          first_name: "Ada",
          last_name: "Lovelace",
          email_address: "ada@example.com",
          last_active: "2026-07-14T09:00:00.000Z",
          country_code: "GB",
          region_code: "ENG",
          region: "England",
          city: "London",
          timezone: "Europe/London",
          latitude: "51.5",
          longitude: "-0.12",
        },
      ],
    });
    getRemoteActiveUserMapMock.mockResolvedValue({
      enabled: true,
      checked_at: "2026-07-14T10:00:00.000Z",
      bay_id: "bay-2",
      current_bay_id: "bay-2",
      active_minutes: 60,
      total_active: 2,
      mapped_active: 1,
      unknown_location: 1,
      countries: [
        {
          country_code: "US",
          latitude: 33.45,
          longitude: -112.07,
          count: 1,
          users: [
            {
              account_id: "account-1",
              bay_id: "bay-2",
              display_name: "Ada",
              first_name: "Ada",
              last_name: "Lovelace",
              email_address: "ada@example.com",
              last_active: "2026-07-14T10:00:00.000Z",
              region_code: "AZ",
              region: "Arizona",
              city: "Phoenix",
              timezone: "America/Phoenix",
            },
          ],
        },
      ],
      unknown_users: [
        {
          account_id: "account-2",
          bay_id: "bay-2",
          display_name: "Grace",
          first_name: "Grace",
          last_name: "Hopper",
          email_address: "grace@example.com",
          last_active: "2026-07-14T09:30:00.000Z",
          region_code: null,
          region: null,
          city: null,
          timezone: null,
        },
      ],
      bays: [{ bay_id: "bay-2", ok: true, enabled: true, total_active: 2 }],
    });

    const { getActiveUserMapOverviewAcrossBays } =
      await import("./account-presence-locations");
    const result = await getActiveUserMapOverviewAcrossBays({
      account_id: "admin-1",
      active_minutes: 60,
    });

    expect(getRemoteActiveUserMapMock).toHaveBeenCalledWith(
      "bay-2",
      { timeout_ms: 10_000 },
      { account_id: "admin-1", active_minutes: 60, group_by: "country" },
    );
    expect(result).toMatchObject({
      bay_id: "all",
      current_bay_id: "bay-1",
      total_active: 2,
      mapped_active: 1,
      unknown_location: 1,
      bays: [
        { bay_id: "bay-1", ok: true, total_active: 1 },
        { bay_id: "bay-2", ok: true, total_active: 2 },
      ],
    });
    expect(result.countries[0]).toMatchObject({
      country_code: "US",
      count: 1,
    });
    expect(result.countries[0]).not.toHaveProperty("users");
    expect(result).not.toHaveProperty("unknown_users");

    const { getActiveUserMapDetailsAcrossBays } =
      await import("./account-presence-locations");
    const details = await getActiveUserMapDetailsAcrossBays({
      account_id: "admin-1",
      active_minutes: 60,
      scope: "all",
    });
    expect(details).toMatchObject({
      total: 2,
      users: [
        {
          account_id: "account-1",
          bay_id: "bay-2",
          city: "Phoenix",
          name: "Ada",
        },
        {
          account_id: "account-2",
          bay_id: "bay-2",
          name: "Grace",
        },
      ],
      domain_counts: [{ domain: "example.com", count: 2 }],
      bays: [
        { bay_id: "bay-1", ok: true, total_active: 1 },
        { bay_id: "bay-2", ok: true, total_active: 2 },
      ],
    });
  });

  it("returns local activity and reports an unavailable remote bay", async () => {
    listConfiguredBaysMock.mockResolvedValue([
      { bay_id: "bay-1" },
      { bay_id: "bay-2" },
    ]);
    getRemoteActiveUserMapMock.mockRejectedValue(Error("bay offline"));

    const { getActiveUserMapOverviewAcrossBays } =
      await import("./account-presence-locations");
    const result = await getActiveUserMapOverviewAcrossBays({
      account_id: "admin-1",
      active_minutes: 15,
    });

    expect(result.total_active).toBe(0);
    expect(result.bays).toEqual([
      { bay_id: "bay-1", ok: true, enabled: true, total_active: 0 },
      { bay_id: "bay-2", ok: false, error: "Error: bay offline" },
    ]);

    const { getActiveUserMapDetailsAcrossBays } =
      await import("./account-presence-locations");
    const details = await getActiveUserMapDetailsAcrossBays({
      account_id: "admin-1",
      active_minutes: 15,
      scope: "all",
    });
    expect(details.bays).toEqual([
      { bay_id: "bay-1", ok: true, enabled: true, total_active: 0 },
      { bay_id: "bay-2", ok: false, error: "Error: bay offline" },
    ]);
  });

  it("rejects activity windows that are not explicitly supported", async () => {
    const { getActiveUserMapReport } =
      await import("./account-presence-locations");
    await expect(
      getActiveUserMapReport({ active_minutes: 30 }),
    ).rejects.toThrow("active_minutes must be one of 5, 15, 60, or 1440");
    expect(queryMock).not.toHaveBeenCalled();
  });
});
