/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Space, Typography } from "antd";

import { Icon, Tooltip } from "@cocalc/frontend/components";
import { COLORS } from "@cocalc/util/theme";
import { ACTIVE_USERS_MAP_COUNTRY_LABELS } from "./active-users-map-country-labels";
import {
  ACTIVE_USERS_MAP_ASSET_URL,
  ACTIVE_USERS_MAP_REGION_ASSET_URL,
  projectActiveUserMapPosition,
} from "./active-users-map-geometry";
import {
  ACTIVE_USERS_MAP_MAX_ZOOM,
  ACTIVE_USERS_MAP_MIN_ZOOM,
  type ActiveUsersMapViewportTransform,
  useActiveUsersMapZoom,
} from "./active-users-map-zoom";
import { activeUsersMapCountryName } from "./active-users-map-country";

const { Text } = Typography;

export interface ActiveUsersMapCountryCount {
  group_id?: string;
  granularity?: "country" | "region" | "city";
  country_code: string;
  region_code?: string | null;
  region?: string | null;
  city?: string | null;
  count: number;
  latitude?: number;
  longitude?: number;
}

function bubbleSize(count: number): number {
  return Math.min(52, Math.max(18, 14 + Math.sqrt(count) * 8));
}

export function transformActiveUsersMapPosition(
  position: { left: number; top: number },
  transform: ActiveUsersMapViewportTransform,
): { left: string; top: string } {
  if (transform.x === 0 && transform.y === 0 && transform.k === 1) {
    return { left: `${position.left}%`, top: `${position.top}%` };
  }
  const coordinate = (percent: number, pixels: number) =>
    `calc(${percent}% ${pixels < 0 ? "-" : "+"} ${Math.abs(pixels)}px)`;
  return {
    left: coordinate(position.left * transform.k, transform.x),
    top: coordinate(position.top * transform.k, transform.y),
  };
}

export function activeUsersMapCountryPosition(
  country: ActiveUsersMapCountryCount,
): {
  left: number;
  top: number;
} {
  if (country.granularity && country.granularity !== "country") {
    return projectActiveUserMapPosition({
      latitude: country.latitude ?? 0,
      longitude: country.longitude ?? 0,
    });
  }
  const [longitude, latitude] = ACTIVE_USERS_MAP_COUNTRY_LABELS[
    country.country_code
  ] ?? [country.longitude ?? 0, country.latitude ?? 0];
  return projectActiveUserMapPosition({ latitude, longitude });
}

export function activeUsersMapLocationName(
  location: ActiveUsersMapCountryCount,
): string {
  const country = activeUsersMapCountryName(location.country_code);
  if (location.granularity === "city" && location.city) {
    return [location.city, location.region ?? location.region_code, country]
      .filter(Boolean)
      .join(", ");
  }
  if (location.granularity === "region") {
    return [location.region ?? location.region_code, country]
      .filter(Boolean)
      .join(", ");
  }
  return country;
}

export function ActiveUsersMapPlot({
  countries,
  selectedCountryCode,
  onSelect,
}: {
  countries: ActiveUsersMapCountryCount[];
  selectedCountryCode?: string;
  onSelect: (countryCode: string) => void;
}) {
  const { reset, transform, viewportRef, zoomBy } = useActiveUsersMapZoom();
  const showRegions = transform.k > 2;

  return (
    <div
      ref={viewportRef}
      role="group"
      aria-label="World map of active users"
      style={{
        aspectRatio: "2 / 1",
        background: COLORS.BLUE_LLL,
        borderRadius: 8,
        cursor: transform.k > ACTIVE_USERS_MAP_MIN_ZOOM ? "grab" : "zoom-in",
        overflow: "hidden",
        position: "relative",
        touchAction: "none",
        width: "100%",
      }}
    >
      <MapLayerImage src={ACTIVE_USERS_MAP_ASSET_URL} transform={transform} />
      {showRegions && (
        <MapLayerImage
          src={ACTIVE_USERS_MAP_REGION_ASSET_URL}
          transform={transform}
        />
      )}
      {countries.map((country) => {
        const size = bubbleSize(country.count);
        const groupId = country.group_id ?? country.country_code;
        const name = activeUsersMapLocationName(country);
        const selected = selectedCountryCode === groupId;
        const label = `${name}: ${country.count} active user${country.count === 1 ? "" : "s"}`;
        const position = transformActiveUsersMapPosition(
          activeUsersMapCountryPosition(country),
          transform,
        );
        return (
          <Tooltip key={groupId} title={label}>
            <button
              aria-label={label}
              aria-pressed={selected}
              onClick={() => onSelect(groupId)}
              style={{
                alignItems: "center",
                background: selected ? COLORS.BLUE_D : COLORS.BLUE_L,
                border: `2px solid ${COLORS.BLUE_D}`,
                borderRadius: "50%",
                boxShadow: selected ? `0 0 0 4px ${COLORS.BLUE_L}` : undefined,
                color: selected ? COLORS.GRAY_LLL : COLORS.BLUE_D,
                cursor: "pointer",
                display: "flex",
                fontSize: Math.min(14, Math.max(10, size / 3)),
                fontWeight: 700,
                height: size,
                justifyContent: "center",
                left: position.left,
                padding: 0,
                position: "absolute",
                top: position.top,
                transform: "translate(-50%, -50%)",
                width: size,
              }}
              type="button"
            >
              {country.count}
            </button>
          </Tooltip>
        );
      })}
      <Space.Compact
        data-map-control
        style={{ position: "absolute", right: 8, top: 8, zIndex: 2 }}
      >
        <Button
          aria-label="Zoom in"
          disabled={transform.k >= ACTIVE_USERS_MAP_MAX_ZOOM}
          icon={<Icon name="search-plus" />}
          onClick={() => zoomBy(2)}
          size="small"
          title="Zoom in"
        />
        <Button
          aria-label="Zoom out"
          disabled={transform.k <= ACTIVE_USERS_MAP_MIN_ZOOM}
          icon={<Icon name="search-minus" />}
          onClick={() => zoomBy(0.5)}
          size="small"
          title="Zoom out"
        />
        <Button
          disabled={
            transform.x === 0 &&
            transform.y === 0 &&
            transform.k === ACTIVE_USERS_MAP_MIN_ZOOM
          }
          icon={<Icon name="undo" />}
          onClick={reset}
          size="small"
        >
          Reset
        </Button>
      </Space.Compact>
      <Text
        style={{
          background: COLORS.GRAY_LLL,
          borderRadius: 4,
          bottom: 8,
          fontSize: 12,
          left: 8,
          padding: "2px 6px",
          position: "absolute",
          zIndex: 2,
        }}
        type="secondary"
      >
        Scroll to zoom · Drag to pan
      </Text>
    </div>
  );
}

function MapLayerImage({
  src,
  transform,
}: {
  src: string;
  transform: ActiveUsersMapViewportTransform;
}) {
  return (
    <img
      alt=""
      aria-hidden="true"
      draggable={false}
      src={src}
      style={{
        height: `${transform.k * 100}%`,
        left: transform.x,
        pointerEvents: "none",
        position: "absolute",
        top: transform.y,
        width: `${transform.k * 100}%`,
      }}
    />
  );
}
