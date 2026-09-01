/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  DatePicker,
  Drawer,
  Radio,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import { CaretRightFilled, PauseOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import utc from "dayjs/plugin/utc";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";

import type {
  ActiveUserMapDetails,
  ActiveUserMapDetailUser,
  ActiveUserMapBayStatus,
  ActiveUserMapGrouping,
  ActiveUserMapOverview,
  ActiveUserMapWindowMinutes,
} from "@cocalc/conat/hub/api/system";
import type {
  ActiveUserMapHistorySeries,
  ActiveUserMapHistorySnapshot,
  ActiveUserMapHistoryWindowMinutes,
} from "@cocalc/conat/inter-bay/api";
import { COLORS } from "@cocalc/util/theme";
import { Icon, TimeAgo, Tooltip } from "@cocalc/frontend/components";
import ShowError from "@cocalc/frontend/components/error";
import {
  user_search,
  type User,
} from "@cocalc/frontend/frame-editors/generic/client";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { UserResult } from "./users/user";
import {
  activeUsersMapLocationName,
  ActiveUsersMapPlot,
} from "./active-users-map-plot";
import { ActiveUsersMapDomainChart } from "./active-users-map-domains";
import { ActiveUsersMapHistoryPlot } from "./active-users-map-history-plot";
import { ActiveUsersMapSummary } from "./active-users-map-summary";

const { Paragraph, Text } = Typography;
dayjs.extend(utc);
const REFRESH_MS = 60_000;
const DRAWER_WIDTH_STORAGE_KEY = "cocalc:admin:activeUsersMapDrawerWidth";
const DEFAULT_DRAWER_WIDTH = "70%";
const MIN_DRAWER_WIDTH = 560;

function clampDrawerWidth(width: number): number {
  if (typeof window === "undefined") return Math.max(MIN_DRAWER_WIDTH, width);
  const maximum = Math.max(320, window.innerWidth - 48);
  const minimum = Math.min(MIN_DRAWER_WIDTH, maximum);
  return Math.min(maximum, Math.max(minimum, width));
}

function readDrawerWidth(): number | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const value = Number(window.localStorage.getItem(DRAWER_WIDTH_STORAGE_KEY));
    return Number.isFinite(value) && value > 0
      ? clampDrawerWidth(value)
      : undefined;
  } catch {
    return undefined;
  }
}

function persistDrawerWidth(width: number): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    DRAWER_WIDTH_STORAGE_KEY,
    `${clampDrawerWidth(width)}`,
  );
}

const WINDOW_OPTIONS: Array<{
  label: string;
  value: ActiveUserMapWindowMinutes;
}> = [
  { label: "5 min", value: 5 },
  { label: "15 min", value: 15 },
  { label: "1 hour", value: 60 },
  { label: "1 day", value: 1440 },
];
const GROUPING_OPTIONS: Array<{
  label: string;
  value: ActiveUserMapGrouping;
}> = [
  { label: "Country", value: "country" },
  { label: "Region", value: "region" },
  { label: "City", value: "city" },
];

const HISTORY_WINDOW_OPTIONS: Array<{
  label: string;
  value: ActiveUserMapHistoryWindowMinutes;
}> = [
  { label: "1 hour", value: 60 },
  { label: "1 day", value: 1440 },
];
const SPEED_OPTIONS = [1, 2, 4, 8].map((speed) => ({
  label: `${speed}×`,
  value: speed,
}));
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => ({
  label: `${hour.toString().padStart(2, "0")}:00 UTC`,
  value: hour,
}));

type MapView = "live" | "history";
type Playback = "date" | "time";

function PlaybackIcon({ playing }: { playing: boolean }) {
  return playing ? <PauseOutlined /> : <CaretRightFilled />;
}

function userName(user: ActiveUserMapDetailUser): string {
  return user.name || user.email_address || user.account_id;
}

function locationLabel(user: ActiveUserMapDetailUser): string {
  return [user.city, user.region_code ?? user.region]
    .filter(Boolean)
    .join(", ");
}

export function activeUsersMapDrawerTitle(
  location: string,
  count: number,
): string {
  return `${location}: ${count} active ${count === 1 ? "user" : "users"}`;
}

export function activeUsersMapIncompleteReasons(
  bays?: ActiveUserMapBayStatus[],
): string[] {
  const failed = bays?.filter(({ ok }) => !ok) ?? [];
  const disabled =
    bays?.filter(({ ok, enabled }) => ok && enabled === false) ?? [];
  return [
    failed.length
      ? `Unavailable: ${failed.map(({ bay_id }) => bay_id).join(", ")}.`
      : "",
    disabled.length
      ? `Collection disabled: ${disabled
          .map(({ bay_id }) => bay_id)
          .join(", ")}.`
      : "",
  ].filter(Boolean);
}

export function activeUsersMapHistoryFallbackCountries(
  locations: ActiveUserMapOverview["countries"],
): ActiveUserMapOverview["countries"] {
  const countries = new Map<
    string,
    ActiveUserMapOverview["countries"][number]
  >();
  for (const location of locations) {
    const existing = countries.get(location.country_code);
    if (existing) {
      existing.count += location.count;
      continue;
    }
    countries.set(location.country_code, {
      ...location,
      group_id: location.country_code,
      granularity: "country",
      region_code: null,
      region: null,
      city: null,
    });
  }
  return [...countries.values()].sort(
    (a, b) => b.count - a.count || a.country_code.localeCompare(b.country_code),
  );
}

function UserList({
  users,
  onSelect,
}: {
  users: ActiveUserMapDetailUser[];
  onSelect: (user: ActiveUserMapDetailUser, trigger: HTMLElement) => void;
}) {
  return (
    <div aria-label="Active users" role="list">
      <Virtuoso
        data={users}
        computeItemKey={(_, user) => user.account_id}
        components={{
          EmptyPlaceholder: () => (
            <Text type="secondary">No users in this group.</Text>
          ),
        }}
        itemContent={(_, user) => (
          <div
            role="listitem"
            style={{
              borderBottom: `1px solid ${COLORS.GRAY_LL}`,
              padding: "12px 0",
            }}
          >
            <div
              style={{
                alignItems: "flex-start",
                display: "flex",
                gap: 16,
                justifyContent: "space-between",
              }}
            >
              <Space orientation="vertical" size="small">
                <Text strong>{userName(user)}</Text>
                <Space size="small" wrap>
                  {user.email_address && (
                    <Text copyable>{user.email_address}</Text>
                  )}
                  {locationLabel(user) && <Tag>{locationLabel(user)}</Tag>}
                  <Tag>Bay: {user.bay_id}</Tag>
                  <Text type="secondary">
                    Active <TimeAgo date={user.last_active} />
                  </Text>
                </Space>
              </Space>
              <Button
                size="small"
                onClick={(event) => onSelect(user, event.currentTarget)}
              >
                Admin details
              </Button>
            </div>
          </div>
        )}
        style={{ height: "clamp(180px, 45vh, 720px)" }}
      />
    </div>
  );
}

export function ActiveUsersMapAdmin() {
  const userDrawerTitleId = useId();
  const [view, setView] = useState<MapView>("live");
  const [liveActiveMinutes, setLiveActiveMinutes] =
    useState<ActiveUserMapWindowMinutes>(15);
  const [liveGrouping, setLiveGrouping] =
    useState<ActiveUserMapGrouping>("country");
  const [historyActiveMinutes, setHistoryActiveMinutes] =
    useState<ActiveUserMapHistoryWindowMinutes>(60);
  const [overview, setOverview] = useState<ActiveUserMapOverview>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [history, setHistory] = useState<ActiveUserMapHistorySeries>();
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string>();
  const [historySnapshot, setHistorySnapshot] =
    useState<ActiveUserMapHistorySnapshot>();
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string>();
  const [historyCountry, setHistoryCountry] = useState<string>();
  const [playback, setPlayback] = useState<Playback>();
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [selectedGroup, setSelectedGroup] = useState<string>();
  const [details, setDetails] = useState<ActiveUserMapDetails>();
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string>();
  const [selectedDetailUser, setSelectedDetailUser] =
    useState<ActiveUserMapDetailUser>();
  const [selectedUser, setSelectedUser] = useState<User>();
  const [loadingUser, setLoadingUser] = useState(false);
  const [userError, setUserError] = useState<string>();
  const [drawerWidth, setDrawerWidth] = useState<number | undefined>(
    readDrawerWidth,
  );
  const liveRequest = useRef(0);
  const detailsRequest = useRef(0);
  const userRequest = useRef(0);
  const userTriggerRef = useRef<HTMLElement | null>(null);
  const snapshotRequest = useRef(0);
  const requestedHistorySnapshot = useRef<string | undefined>(undefined);
  const snapshotCache = useRef(
    new Map<string, ActiveUserMapHistorySnapshot | null>(),
  );
  const plotActiveMinutes: ActiveUserMapHistoryWindowMinutes =
    view === "history"
      ? historyActiveMinutes
      : liveActiveMinutes === 1440
        ? 1440
        : 60;

  const load = useCallback(async () => {
    const request = ++liveRequest.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await webapp_client.conat_client.hub.system.getActiveUserMap(
        {
          active_minutes: liveActiveMinutes,
          group_by: liveGrouping,
        },
      );
      if (request === liveRequest.current) setOverview(next);
    } catch (err) {
      if (request === liveRequest.current) setError(`${err}`);
    } finally {
      if (request === liveRequest.current) setLoading(false);
    }
  }, [liveActiveMinutes, liveGrouping]);

  const loadDetails = useCallback(async () => {
    if (view !== "live" || selectedGroup == null) return;
    const request = ++detailsRequest.current;
    setDetailsLoading(true);
    setDetailsError(undefined);
    try {
      const next =
        await webapp_client.conat_client.hub.system.getActiveUserMapDetails({
          active_minutes: liveActiveMinutes,
          group_by: liveGrouping,
          scope:
            selectedGroup === "all"
              ? "all"
              : selectedGroup === "unknown"
                ? "unknown"
                : "group",
          group_id:
            selectedGroup === "unknown" || selectedGroup === "all"
              ? undefined
              : selectedGroup,
        });
      if (request === detailsRequest.current) setDetails(next);
    } catch (err) {
      if (request === detailsRequest.current) setDetailsError(`${err}`);
    } finally {
      if (request === detailsRequest.current) setDetailsLoading(false);
    }
  }, [liveActiveMinutes, liveGrouping, selectedGroup, view]);

  useEffect(() => {
    if (view !== "live") return;
    void load();
    const timer = setInterval(() => {
      if (typeof document === "undefined" || !document.hidden) {
        void load();
      }
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, view]);

  useEffect(() => {
    setDetails(undefined);
    if (view === "live" && selectedGroup != null) {
      void loadDetails();
    }
    return () => {
      detailsRequest.current += 1;
    };
  }, [loadDetails, selectedGroup, view]);

  useEffect(() => {
    let disposed = false;
    setHistoryLoading(true);
    setHistoryError(undefined);
    void (async () => {
      try {
        const next =
          await webapp_client.conat_client.hub.system.getActiveUserMapHistorySeries(
            {
              active_minutes: plotActiveMinutes,
              country_code: historyCountry,
            },
          );
        if (!disposed) setHistory(next);
      } catch (err) {
        if (!disposed) setHistoryError(`${err}`);
      } finally {
        if (!disposed) setHistoryLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [historyCountry, plotActiveMinutes]);

  const loadHistorySnapshot = useCallback(
    async ({
      activeMinutes,
      snapshotHour,
      direction = "nearest",
    }: {
      activeMinutes: ActiveUserMapHistoryWindowMinutes;
      snapshotHour?: string;
      direction?: "backward" | "forward" | "nearest";
    }): Promise<ActiveUserMapHistorySnapshot | null> => {
      const cacheKey = `${activeMinutes}:${snapshotHour ?? "latest"}:${direction}`;
      const request = ++snapshotRequest.current;
      if (snapshotHour && snapshotCache.current.has(cacheKey)) {
        const cached = snapshotCache.current.get(cacheKey) ?? null;
        if (cached) setHistorySnapshot(cached);
        setSnapshotLoading(false);
        return cached;
      }
      setSnapshotLoading(true);
      setSnapshotError(undefined);
      try {
        const next =
          await webapp_client.conat_client.hub.system.getActiveUserMapHistorySnapshot(
            {
              active_minutes: activeMinutes,
              snapshot_hour: snapshotHour,
              direction,
            },
          );
        if (next) {
          if (snapshotHour) snapshotCache.current.set(cacheKey, next);
          snapshotCache.current.set(
            `${activeMinutes}:${next.snapshot_hour}:nearest`,
            next,
          );
        }
        if (request === snapshotRequest.current && next) {
          setHistorySnapshot(next);
        }
        return next;
      } catch (err) {
        if (request === snapshotRequest.current) setSnapshotError(`${err}`);
        return null;
      } finally {
        if (request === snapshotRequest.current) setSnapshotLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (view !== "history") return;
    setPlayback(undefined);
    const snapshotHour = requestedHistorySnapshot.current;
    requestedHistorySnapshot.current = undefined;
    void loadHistorySnapshot({
      activeMinutes: historyActiveMinutes,
      snapshotHour,
    });
  }, [historyActiveMinutes, loadHistorySnapshot, view]);

  const stepHistorySnapshot = useCallback(
    async (kind: Playback, amount: -1 | 1) => {
      if (!historySnapshot) return null;
      const snapshotHour = dayjs
        .utc(historySnapshot.snapshot_hour)
        .add(amount, kind === "date" ? "day" : "hour")
        .toISOString();
      return await loadHistorySnapshot({
        activeMinutes: historyActiveMinutes,
        snapshotHour,
        direction: amount < 0 ? "backward" : "forward",
      });
    },
    [historyActiveMinutes, historySnapshot, loadHistorySnapshot],
  );

  useEffect(() => {
    if (!playback || view !== "history" || snapshotLoading) return;
    const currentSnapshotHour = historySnapshot?.snapshot_hour;
    const timer = setTimeout(() => {
      void (async () => {
        const next = await stepHistorySnapshot(playback, 1);
        if (!next || next.snapshot_hour === currentSnapshotHour) {
          setPlayback(undefined);
        }
      })();
    }, 1000 / playbackSpeed);
    return () => clearTimeout(timer);
  }, [
    historySnapshot?.snapshot_hour,
    playback,
    playbackSpeed,
    snapshotLoading,
    stepHistorySnapshot,
    view,
  ]);

  const selectedLocation = overview?.countries.find(
    (location) =>
      (location.group_id ?? location.country_code) === selectedGroup,
  );
  function closeUserDrawer() {
    userRequest.current += 1;
    setSelectedDetailUser(undefined);
    setSelectedUser(undefined);
    setLoadingUser(false);
    setUserError(undefined);
  }

  function selectLiveGroup(group?: string) {
    detailsRequest.current += 1;
    setDetails(undefined);
    setDetailsLoading(false);
    setDetailsError(undefined);
    setSelectedGroup(group);
    closeUserDrawer();
  }

  async function openUser(user: ActiveUserMapDetailUser, trigger: HTMLElement) {
    const request = ++userRequest.current;
    userTriggerRef.current = trigger;
    setSelectedDetailUser(user);
    setLoadingUser(true);
    setSelectedUser(undefined);
    setUserError(undefined);
    try {
      const result = await user_search({
        query: user.account_id,
        admin: true,
        limit: 1,
      });
      if (request !== userRequest.current) return;
      if (!result?.[0]) {
        throw Error("Account details are unavailable.");
      }
      setSelectedUser(result[0]);
    } catch (err) {
      if (request === userRequest.current) setUserError(`${err}`);
    } finally {
      if (request === userRequest.current) setLoadingUser(false);
    }
  }

  const drawerLocation =
    selectedGroup === "all"
      ? "All locations"
      : selectedGroup === "unknown"
        ? "Location unavailable"
        : selectedLocation
          ? activeUsersMapLocationName(selectedLocation)
          : "Selected location";
  const drawerTitle = activeUsersMapDrawerTitle(
    drawerLocation,
    details?.total ??
      (selectedGroup === "unknown"
        ? (overview?.unknown_location ?? 0)
        : (selectedLocation?.count ?? 0)),
  );
  const incompleteMapReasons = activeUsersMapIncompleteReasons(overview?.bays);
  const incompleteDetailsReasons = activeUsersMapIncompleteReasons(
    details?.bays,
  );
  const historicalDate = historySnapshot
    ? dayjs.utc(historySnapshot.snapshot_hour)
    : undefined;
  const pendingHistoryFallback = snapshotLoading ? overview : undefined;
  const pendingHistoryCountries = pendingHistoryFallback
    ? activeUsersMapHistoryFallbackCountries(pendingHistoryFallback.countries)
    : undefined;
  const displaySummary =
    view === "history" ? (historySnapshot ?? pendingHistoryFallback) : overview;
  const displayCountries =
    view === "history"
      ? (historySnapshot?.countries ?? pendingHistoryCountries)
      : overview?.countries;

  function selectHistoryDate(value: Dayjs | null) {
    if (!value || !historicalDate) return;
    const snapshotHour = historicalDate
      .year(value.year())
      .month(value.month())
      .date(value.date())
      .toISOString();
    void loadHistorySnapshot({
      activeMinutes: historyActiveMinutes,
      snapshotHour,
    });
  }

  function selectHistoryHour(hour: number) {
    if (!historicalDate) return;
    void loadHistorySnapshot({
      activeMinutes: historyActiveMinutes,
      snapshotHour: historicalDate.hour(hour).toISOString(),
    });
  }

  function selectPlotSnapshot(snapshotHour: string) {
    const activeMinutes = history?.active_minutes ?? plotActiveMinutes;
    requestedHistorySnapshot.current = snapshotHour;
    setHistoryActiveMinutes(activeMinutes);
    selectLiveGroup(undefined);
    setView("history");
    if (view === "history" && activeMinutes === historyActiveMinutes) {
      requestedHistorySnapshot.current = undefined;
      void loadHistorySnapshot({ activeMinutes, snapshotHour });
    }
  }

  return (
    <Space vertical size={16} style={{ width: "100%" }}>
      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Accounts across registered bays whose <code>last_active</code> changed
        during the selected window. Locations are approximate, short-lived
        Cloudflare observations; no IP address or account-linked location
        history is stored. Country-level history includes only accounts that
        enabled Usage metrics and is retained indefinitely as aggregate data.
      </Paragraph>
      <Space wrap>
        <Radio.Group
          buttonStyle="solid"
          optionType="button"
          options={[
            { label: "Live", value: "live" },
            { label: "History", value: "history" },
          ]}
          value={view}
          onChange={({ target: { value } }) => {
            const nextView = value as MapView;
            setPlayback(undefined);
            selectLiveGroup(undefined);
            if (nextView === "history") {
              setSnapshotLoading(true);
            }
            setView(nextView);
          }}
        />
        <Space>
          <Text>Active within:</Text>
          <Radio.Group
            buttonStyle="solid"
            optionType="button"
            options={view === "live" ? WINDOW_OPTIONS : HISTORY_WINDOW_OPTIONS}
            value={view === "live" ? liveActiveMinutes : historyActiveMinutes}
            onChange={({ target: { value } }) => {
              setPlayback(undefined);
              if (view === "live") {
                selectLiveGroup(undefined);
                setLiveActiveMinutes(value as ActiveUserMapWindowMinutes);
              } else {
                requestedHistorySnapshot.current =
                  historySnapshot?.snapshot_hour;
                setSnapshotLoading(true);
                setHistoryActiveMinutes(
                  value as ActiveUserMapHistoryWindowMinutes,
                );
              }
            }}
          />
        </Space>
        {view === "history" && (
          <Space>
            <Text>Date:</Text>
            <Space.Compact>
              <Button
                aria-label="Previous day"
                disabled={!historicalDate || snapshotLoading}
                icon={<Icon name="chevron-left" />}
                onClick={() => void stepHistorySnapshot("date", -1)}
              />
              <DatePicker
                allowClear={false}
                disabled={!historicalDate || snapshotLoading}
                format="MMMM D, YYYY"
                value={historicalDate}
                onChange={selectHistoryDate}
              />
              <Button
                aria-label="Next day"
                disabled={!historicalDate || snapshotLoading}
                icon={<Icon name="chevron-right" />}
                onClick={() => void stepHistorySnapshot("date", 1)}
              />
              <Button
                aria-label={
                  playback === "date"
                    ? "Pause daily playback"
                    : "Play one day per frame"
                }
                disabled={!historicalDate}
                icon={<PlaybackIcon playing={playback === "date"} />}
                onClick={() =>
                  setPlayback((current) =>
                    current === "date" ? undefined : "date",
                  )
                }
                type={playback === "date" ? "primary" : "default"}
              />
            </Space.Compact>
          </Space>
        )}
        {view === "history" && (
          <Space>
            <Text>Time:</Text>
            <Space.Compact>
              <Button
                aria-label="Previous hour"
                disabled={!historicalDate || snapshotLoading}
                icon={<Icon name="chevron-left" />}
                onClick={() => void stepHistorySnapshot("time", -1)}
              />
              <Select
                disabled={!historicalDate || snapshotLoading}
                options={HOUR_OPTIONS}
                value={historicalDate?.hour()}
                onChange={selectHistoryHour}
                style={{ width: 120 }}
              />
              <Button
                aria-label="Next hour"
                disabled={!historicalDate || snapshotLoading}
                icon={<Icon name="chevron-right" />}
                onClick={() => void stepHistorySnapshot("time", 1)}
              />
              <Button
                aria-label={
                  playback === "time"
                    ? "Pause hourly playback"
                    : "Play one hour per frame"
                }
                disabled={!historicalDate}
                icon={<PlaybackIcon playing={playback === "time"} />}
                onClick={() =>
                  setPlayback((current) =>
                    current === "time" ? undefined : "time",
                  )
                }
                type={playback === "time" ? "primary" : "default"}
              />
            </Space.Compact>
          </Space>
        )}
        {view === "history" && (
          <Space>
            <Text>Speed:</Text>
            <Select
              options={SPEED_OPTIONS}
              value={playbackSpeed}
              onChange={setPlaybackSpeed}
              style={{ width: 72 }}
            />
          </Space>
        )}
        {view === "live" && (
          <Space>
            <Text>Group by:</Text>
            <Tooltip title="Group current users using approximate Cloudflare IP geolocation. Region means a state, province, or equivalent first-level administrative area.">
              <Radio.Group
                aria-label="Group by location"
                buttonStyle="solid"
                optionType="button"
                options={GROUPING_OPTIONS}
                value={liveGrouping}
                onChange={({ target: { value } }) => {
                  selectLiveGroup(undefined);
                  setLiveGrouping(value as ActiveUserMapGrouping);
                }}
              />
            </Tooltip>
          </Space>
        )}
      </Space>
      {error && <ShowError error={error} setError={setError} />}
      {snapshotError && (
        <ShowError error={snapshotError} setError={setSnapshotError} />
      )}
      {incompleteMapReasons.length > 0 && overview?.enabled ? (
        <Alert
          showIcon
          type="warning"
          title="The active-users map is incomplete"
          description={incompleteMapReasons.join(" ")}
        />
      ) : null}
      {overview && !overview.enabled ? (
        <Alert
          showIcon
          type="info"
          title="Active users map is disabled"
          description="Enable Active Users Map in Admin → Site Settings after verifying Cloudflare visitor-location headers."
        />
      ) : null}
      {overview?.enabled ? (
        <>
          {displaySummary ? (
            <ActiveUsersMapSummary
              total={displaySummary.total_active}
              mapped={displaySummary.mapped_active}
              usageMetricsNotEnabled={
                view === "history"
                  ? historySnapshot?.usage_metrics_not_enabled
                  : undefined
              }
              unavailable={displaySummary.unknown_location}
              onShowAll={
                view === "live" ? () => selectLiveGroup("all") : undefined
              }
              onShowUnavailable={
                view === "live" ? () => selectLiveGroup("unknown") : undefined
              }
              hint={
                view === "live"
                  ? `Select a ${liveGrouping} to view its active users.`
                  : "Select a country to filter the plot."
              }
            />
          ) : snapshotLoading || loading ? (
            <div style={{ padding: 48, textAlign: "center" }}>
              <Spin />
            </div>
          ) : null}
          <ActiveUsersMapPlot
            key="active-users-map"
            countries={displayCountries ?? []}
            selectedCountryCode={
              view === "history" ? historyCountry : selectedGroup
            }
            onSelect={view === "history" ? setHistoryCountry : selectLiveGroup}
          />
          {historyError && (
            <ShowError error={historyError} setError={setHistoryError} />
          )}
          <ActiveUsersMapHistoryPlot
            history={history}
            loading={historyLoading}
            selectedCountryCode={historyCountry}
            selectedSnapshotHour={
              view === "history" ? historySnapshot?.snapshot_hour : undefined
            }
            onCountryChange={setHistoryCountry}
            onSelectSnapshot={selectPlotSnapshot}
          />
        </>
      ) : loading && !overview ? (
        <div style={{ padding: 48, textAlign: "center" }}>
          <Spin />
        </div>
      ) : null}
      <Drawer
        open={view === "live" && selectedGroup != null}
        placement="right"
        size={drawerWidth ?? DEFAULT_DRAWER_WIDTH}
        resizable={{
          onResize: (width) => {
            const next = clampDrawerWidth(width);
            setDrawerWidth(next);
            try {
              persistDrawerWidth(next);
            } catch {
              // Resizing still works when localStorage is unavailable.
            }
          },
        }}
        title={drawerTitle}
        onClose={() => selectLiveGroup(undefined)}
      >
        {detailsError && (
          <ShowError error={detailsError} setError={setDetailsError} />
        )}
        {incompleteDetailsReasons.length > 0 ? (
          <Alert
            showIcon
            type="warning"
            title="Active-user details are incomplete"
            description={incompleteDetailsReasons.join(" ")}
          />
        ) : null}
        {details ? (
          <>
            <ActiveUsersMapDomainChart
              counts={details.domain_counts}
              total={details.total}
            />
            <UserList
              users={details.users}
              onSelect={(user, trigger) => void openUser(user, trigger)}
            />
          </>
        ) : detailsLoading ? (
          <div style={{ padding: 48, textAlign: "center" }}>
            <Spin description="Loading active users" />
          </div>
        ) : null}
        <Drawer
          aria-labelledby={userDrawerTitleId}
          afterOpenChange={(open) => {
            if (!open && selectedGroup != null) {
              userTriggerRef.current?.focus();
            }
          }}
          destroyOnHidden
          onClose={closeUserDrawer}
          open={selectedDetailUser != null}
          placement="right"
          size={drawerWidth ?? DEFAULT_DRAWER_WIDTH}
          styles={{ body: { padding: 16 } }}
          title={
            <Space id={userDrawerTitleId}>
              <Icon name="user" />
              <span>
                {selectedDetailUser
                  ? `${userName(selectedDetailUser)} admin details`
                  : "User admin details"}
              </span>
            </Space>
          }
        >
          {userError && <ShowError error={userError} setError={setUserError} />}
          {loadingUser ? (
            <div style={{ padding: 48, textAlign: "center" }}>
              <Spin description="Loading user details" />
            </div>
          ) : selectedUser ? (
            <UserResult
              key={selectedUser.account_id}
              {...selectedUser}
              defaultExpanded
              defaultSection="projects"
            />
          ) : null}
        </Drawer>
      </Drawer>
    </Space>
  );
}
