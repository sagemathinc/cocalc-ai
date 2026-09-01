import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import type { ActiveUserMapDetails } from "@cocalc/conat/hub/api/system";

import {
  ActiveUsersMapAdmin,
  activeUsersMapDrawerTitle,
  activeUsersMapHistoryFallbackCountries,
  activeUsersMapIncompleteReasons,
} from "./active-users-map";
import { ActiveUsersMapSummary } from "./active-users-map-summary";

const mockGetActiveUserMap = jest.fn();
const mockGetActiveUserMapDetails = jest.fn();
const mockGetHistorySeries = jest.fn();
const mockUserSearch = jest.fn();

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        system: {
          getActiveUserMap: (...args: unknown[]) =>
            mockGetActiveUserMap(...args),
          getActiveUserMapDetails: (...args: unknown[]) =>
            mockGetActiveUserMapDetails(...args),
          getActiveUserMapHistorySeries: (...args: unknown[]) =>
            mockGetHistorySeries(...args),
          getActiveUserMapHistorySnapshot: jest.fn(async () => null),
        },
      },
    },
  },
}));
jest.mock("./active-users-map-plot", () => ({
  activeUsersMapLocationName: () => "Location",
  ActiveUsersMapPlot: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <button onClick={() => onSelect("CA")}>Select map location</button>
  ),
}));
jest.mock("./active-users-map-domains", () => ({
  ActiveUsersMapDomainChart: ({ total }: { total: number }) => (
    <div>Domains for {total} active users</div>
  ),
}));
jest.mock("./active-users-map-history-plot", () => ({
  ActiveUsersMapHistoryPlot: () => <div>History plot</div>,
}));
jest.mock("react-virtuoso", () => ({
  Virtuoso: ({
    components,
    data = [],
    itemContent,
  }: {
    components?: { EmptyPlaceholder?: () => ReactNode };
    data?: Array<{ account_id: string }>;
    itemContent: (index: number, item: { account_id: string }) => ReactNode;
  }) => (
    <div>
      {data.length === 0
        ? components?.EmptyPlaceholder?.()
        : data.map((item, index) => (
            <div key={item.account_id}>{itemContent(index, item)}</div>
          ))}
    </div>
  ),
}));
jest.mock("./users/user", () => ({
  UserResult: ({
    account_id,
    defaultExpanded,
    defaultSection,
  }: {
    account_id: string;
    defaultExpanded?: boolean;
    defaultSection?: string;
  }) => (
    <div>
      user-result:{account_id}:{defaultSection}:{`${defaultExpanded}`}
    </div>
  ),
}));
jest.mock("@cocalc/frontend/frame-editors/generic/client", () => ({
  user_search: (...args: unknown[]) => mockUserSearch(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockGetActiveUserMap.mockResolvedValue({
    enabled: true,
    checked_at: "2026-08-27T00:00:00.000Z",
    bay_id: "bay-1",
    current_bay_id: "bay-1",
    active_minutes: 15,
    total_active: 0,
    mapped_active: 0,
    unknown_location: 0,
    countries: [],
    bays: [{ bay_id: "bay-1", ok: true, enabled: true, total_active: 0 }],
  });
  mockGetActiveUserMapDetails.mockResolvedValue({
    checked_at: "2026-08-27T00:00:00.000Z",
    total: 0,
    users: [],
    domain_counts: [],
    bays: [{ bay_id: "bay-1", ok: true, enabled: true, total_active: 0 }],
  });
  mockGetHistorySeries.mockResolvedValue({
    active_minutes: 60,
    days: 365,
    country_code: null,
    country_codes: [],
    points: [],
  });
  mockUserSearch.mockResolvedValue([
    {
      account_id: "account-1",
      display_name: "Ada Lovelace",
      email_address: "ada@example.com",
    },
  ]);
});

describe("ActiveUsersMapSummary", () => {
  it("shows compact counts and opens unavailable locations", () => {
    const onShowAll = jest.fn();
    const onShowUnavailable = jest.fn();
    render(
      <ActiveUsersMapSummary
        total={793}
        mapped={435}
        unavailable={358}
        onShowAll={onShowAll}
        onShowUnavailable={onShowUnavailable}
        hint="Select a country to view its active users."
      />,
    );

    expect(
      screen.getByRole("button", { name: "Active users: 793" }),
    ).toBeVisible();
    expect(screen.getByText("On map:")).toHaveTextContent("435");
    expect(
      screen.getByText("Select a country to view its active users."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Active users: 793" }));
    expect(onShowAll).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Location unavailable: 358" }),
    );
    expect(onShowUnavailable).toHaveBeenCalledTimes(1);
  });

  it("does not offer unavailable-location details when there are none", () => {
    render(
      <ActiveUsersMapSummary
        total={42}
        mapped={42}
        unavailable={0}
        onShowUnavailable={jest.fn()}
        hint="Select a country to view its active users."
      />,
    );

    expect(
      screen.queryByRole("button", { name: /Location unavailable/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Location unavailable:")).toHaveTextContent("0");
  });
});

describe("ActiveUsersMapAdmin", () => {
  it("requests live groups selected by country, region, or city", async () => {
    render(<ActiveUsersMapAdmin />);

    expect(
      screen.getByRole("radiogroup", { name: "Group by location" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(mockGetActiveUserMap).toHaveBeenCalledWith({
        active_minutes: 15,
        group_by: "country",
      }),
    );

    fireEvent.click(screen.getByRole("radio", { name: "Region" }));
    await waitFor(() =>
      expect(mockGetActiveUserMap).toHaveBeenLastCalledWith({
        active_minutes: 15,
        group_by: "region",
      }),
    );

    fireEvent.click(screen.getByRole("radio", { name: "City" }));
    await waitFor(() =>
      expect(mockGetActiveUserMap).toHaveBeenLastCalledWith({
        active_minutes: 15,
        group_by: "city",
      }),
    );

    fireEvent.click(screen.getByRole("radio", { name: "History" }));
    expect(
      screen.queryByRole("radiogroup", { name: "Group by location" }),
    ).not.toBeInTheDocument();
  });

  it("loads location users separately from the map overview", async () => {
    mockGetActiveUserMap.mockResolvedValue({
      enabled: true,
      checked_at: "2026-08-27T00:00:00.000Z",
      bay_id: "bay-1",
      current_bay_id: "bay-1",
      active_minutes: 15,
      total_active: 1,
      mapped_active: 1,
      unknown_location: 0,
      countries: [
        {
          group_id: "CA",
          granularity: "country",
          country_code: "CA",
          latitude: 56,
          longitude: -106,
          count: 1,
        },
      ],
      bays: [{ bay_id: "bay-1", ok: true, enabled: true, total_active: 1 }],
    });
    mockGetActiveUserMapDetails.mockResolvedValue({
      checked_at: "2026-08-27T00:00:00.000Z",
      total: 1,
      users: [
        {
          account_id: "account-1",
          bay_id: "bay-1",
          name: "Ada Lovelace",
          email_address: "ada@example.com",
          last_active: "2026-08-27T00:00:00.000Z",
          region_code: "AB",
          region: "Alberta",
          city: "Calgary",
        },
      ],
      domain_counts: [{ domain: "example.com", count: 1 }],
      bays: [{ bay_id: "bay-1", ok: true, enabled: true, total_active: 1 }],
    });

    render(<ActiveUsersMapAdmin />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Select map location" }),
    );

    await waitFor(() =>
      expect(mockGetActiveUserMapDetails).toHaveBeenCalledWith({
        active_minutes: 15,
        group_by: "country",
        scope: "group",
        group_id: "CA",
      }),
    );
    expect(await screen.findByText("Domains for 1 active users")).toBeVisible();
    expect(screen.getByText("Ada Lovelace")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Previous" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Next" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Active users: 1" }));
    await waitFor(() =>
      expect(mockGetActiveUserMapDetails).toHaveBeenLastCalledWith({
        active_minutes: 15,
        group_by: "country",
        scope: "all",
        group_id: undefined,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Admin details" }));
    await waitFor(() =>
      expect(mockUserSearch).toHaveBeenCalledWith({
        query: "account-1",
        admin: true,
        limit: 1,
      }),
    );
    expect(await screen.findByText("Ada Lovelace admin details")).toBeVisible();
    expect(
      await screen.findByText("user-result:account-1:projects:true"),
    ).toBeVisible();
  });

  it("warns when a detail fetch is missing a bay", async () => {
    mockGetActiveUserMapDetails.mockResolvedValue({
      checked_at: "2026-08-27T00:00:00.000Z",
      total: 0,
      users: [],
      domain_counts: [],
      bays: [
        { bay_id: "bay-1", ok: true, enabled: true, total_active: 0 },
        { bay_id: "bay-2", ok: false, error: "bay offline" },
      ],
    });

    render(<ActiveUsersMapAdmin />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Select map location" }),
    );

    expect(
      await screen.findByText("Active-user details are incomplete"),
    ).toBeVisible();
    expect(screen.getByText("Unavailable: bay-2.")).toBeVisible();
  });

  it("does not reuse details that resolve after the drawer closes", async () => {
    let resolveFirst!: (value: ActiveUserMapDetails) => void;
    let resolveSecond!: (value: ActiveUserMapDetails) => void;
    mockGetActiveUserMapDetails
      .mockReturnValueOnce(
        new Promise<ActiveUserMapDetails>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<ActiveUserMapDetails>((resolve) => {
          resolveSecond = resolve;
        }),
      );

    render(<ActiveUsersMapAdmin />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Select map location" }),
    );
    await waitFor(() =>
      expect(mockGetActiveUserMapDetails).toHaveBeenCalledTimes(1),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => {
      resolveFirst({
        checked_at: "2026-08-27T00:00:00.000Z",
        total: 1,
        users: [],
        domain_counts: [{ domain: "stale.test", count: 1 }],
        bays: [{ bay_id: "bay-1", ok: true, total_active: 1 }],
      });
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Select map location" }),
    );
    await waitFor(() =>
      expect(mockGetActiveUserMapDetails).toHaveBeenCalledTimes(2),
    );
    expect(screen.queryByText("Domains for 1 active users")).toBeNull();

    await act(async () => {
      resolveSecond({
        checked_at: "2026-08-27T00:00:00.000Z",
        total: 0,
        users: [],
        domain_counts: [],
        bays: [{ bay_id: "bay-1", ok: true, total_active: 0 }],
      });
    });
    expect(await screen.findByText("Domains for 0 active users")).toBeVisible();
  });
});

describe("activeUsersMapDrawerTitle", () => {
  it("describes named and unavailable locations with user counts", () => {
    expect(activeUsersMapDrawerTitle("Canada", 34)).toBe(
      "Canada: 34 active users",
    );
    expect(activeUsersMapDrawerTitle("Location unavailable", 1)).toBe(
      "Location unavailable: 1 active user",
    );
  });
});

describe("activeUsersMapIncompleteReasons", () => {
  it("describes unavailable and disabled bays", () => {
    expect(
      activeUsersMapIncompleteReasons([
        { bay_id: "bay-1", ok: true, enabled: true },
        { bay_id: "bay-2", ok: false },
        { bay_id: "bay-3", ok: true, enabled: false },
      ]),
    ).toEqual(["Unavailable: bay-2.", "Collection disabled: bay-3."]);
  });
});

describe("activeUsersMapHistoryFallbackCountries", () => {
  it("combines live city groups into country-only history groups", () => {
    const countries = activeUsersMapHistoryFallbackCountries([
      {
        group_id: "city:ca:ab:calgary",
        granularity: "city",
        country_code: "CA",
        region_code: "AB",
        region: "Alberta",
        city: "Calgary",
        latitude: 51.0447,
        longitude: -114.0719,
        count: 2,
      },
      {
        group_id: "city:ca:on:toronto",
        granularity: "city",
        country_code: "CA",
        region_code: "ON",
        region: "Ontario",
        city: "Toronto",
        latitude: 43.6532,
        longitude: -79.3832,
        count: 3,
      },
    ]);

    expect(countries).toEqual([
      expect.objectContaining({
        group_id: "CA",
        granularity: "country",
        country_code: "CA",
        region_code: null,
        region: null,
        city: null,
        count: 5,
      }),
    ]);
  });
});
