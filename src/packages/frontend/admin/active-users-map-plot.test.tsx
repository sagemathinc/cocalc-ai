/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import type { ActiveUserMapCountry } from "@cocalc/conat/hub/api/system";
import {
  ACTIVE_USERS_MAP_ASSET_URL,
  ACTIVE_USERS_MAP_REGION_ASSET_URL,
} from "./active-users-map-geometry";
import {
  activeUsersMapCountryPosition,
  activeUsersMapLocationName,
  ActiveUsersMapPlot,
  transformActiveUsersMapPosition,
} from "./active-users-map-plot";
import { useActiveUsersMapZoom } from "./active-users-map-zoom";

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));
jest.mock("./active-users-map-zoom", () => ({
  ACTIVE_USERS_MAP_MAX_ZOOM: 32,
  ACTIVE_USERS_MAP_MIN_ZOOM: 1,
  useActiveUsersMapZoom: jest.fn(),
}));

const mockReset = jest.fn();
const mockZoomBy = jest.fn();
const mockUseActiveUsersMapZoom = jest.mocked(useActiveUsersMapZoom);

const us: ActiveUserMapCountry = {
  country_code: "US",
  count: 2,
  // Deliberately unrelated to the country label point.
  latitude: 0,
  longitude: 0,
};

describe("ActiveUsersMapPlot", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseActiveUsersMapZoom.mockReturnValue({
      reset: mockReset,
      transform: { k: 1, x: 0, y: 0 },
      viewportRef: { current: null },
      zoomBy: mockZoomBy,
    });
  });

  it("renders the map when there are no active countries", () => {
    const { container } = render(
      <ActiveUsersMapPlot countries={[]} onSelect={jest.fn()} />,
    );

    expect(
      screen.getByRole("group", { name: "World map of active users" }),
    ).toBeInTheDocument();
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      ACTIVE_USERS_MAP_ASSET_URL,
    );
    expect(container.querySelector("img")).toHaveStyle({
      height: "100%",
      left: "0px",
      top: "0px",
      width: "100%",
    });
    expect(container.querySelector("use")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled();
    expect(screen.getByText("Scroll to zoom · Drag to pan")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /active users?$/ }),
    ).not.toBeInTheDocument();
  });

  it("uses the stable country label point and keeps bubbles interactive", () => {
    const onSelect = jest.fn();
    render(<ActiveUsersMapPlot countries={[us]} onSelect={onSelect} />);

    const button = screen.getByRole("button", {
      name: "United States: 2 active users",
    });
    const position = activeUsersMapCountryPosition(us);
    expect(position.left).not.toBe(50);
    expect(position.top).not.toBe(50);
    expect(button).toHaveStyle({
      left: `${position.left}%`,
      top: `${position.top}%`,
    });

    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith("US");
  });

  it("uses approximate coordinates and location labels for city groups", () => {
    const onSelect = jest.fn();
    const calgary: ActiveUserMapCountry = {
      group_id: "city:ca:ab:calgary",
      granularity: "city",
      country_code: "CA",
      region_code: "AB",
      region: "Alberta",
      city: "Calgary",
      count: 3,
      latitude: 51.05,
      longitude: -114.08,
    };
    render(<ActiveUsersMapPlot countries={[calgary]} onSelect={onSelect} />);

    expect(activeUsersMapLocationName(calgary)).toBe(
      "Calgary, Alberta, Canada",
    );
    const button = screen.getByRole("button", {
      name: "Calgary, Alberta, Canada: 3 active users",
    });
    expect(activeUsersMapCountryPosition(calgary)).not.toEqual(
      activeUsersMapCountryPosition({ ...calgary, granularity: "country" }),
    );
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith("city:ca:ab:calgary");
  });

  it("moves bubble positions without scaling their controls", () => {
    expect(
      transformActiveUsersMapPosition(
        { left: 25, top: 40 },
        { k: 2, x: -100, y: 50 },
      ),
    ).toEqual({
      left: "calc(50% - 100px)",
      top: "calc(80% + 50px)",
    });
  });

  it("zooms SVG assets by resizing instead of scaling rasterized images", () => {
    mockUseActiveUsersMapZoom.mockReturnValue({
      reset: mockReset,
      transform: { k: 8, x: -2800, y: -1400 },
      viewportRef: { current: null },
      zoomBy: mockZoomBy,
    });
    const { container } = render(
      <ActiveUsersMapPlot countries={[]} onSelect={jest.fn()} />,
    );

    const baseMap = container.querySelector(
      `img[src="${ACTIVE_USERS_MAP_ASSET_URL}"]`,
    );
    expect(baseMap).toHaveStyle({
      height: "800%",
      left: "-2800px",
      top: "-1400px",
      width: "800%",
    });
    expect(baseMap).not.toHaveStyle({ transform: "scale(8)" });
  });

  it("connects the visible zoom and reset controls", () => {
    const { unmount } = render(
      <ActiveUsersMapPlot countries={[us]} onSelect={jest.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(mockZoomBy).toHaveBeenCalledWith(2);
    unmount();

    mockUseActiveUsersMapZoom.mockReturnValue({
      reset: mockReset,
      transform: { k: 2, x: -100, y: -50 },
      viewportRef: { current: null },
      zoomBy: mockZoomBy,
    });
    render(<ActiveUsersMapPlot countries={[us]} onSelect={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Reset/ }));
    expect(mockReset).toHaveBeenCalled();
  });

  it("shows regional boundaries only above two-times zoom", () => {
    const { container, unmount } = render(
      <ActiveUsersMapPlot countries={[]} onSelect={jest.fn()} />,
    );
    expect(
      container.querySelector(
        `img[src="${ACTIVE_USERS_MAP_REGION_ASSET_URL}"]`,
      ),
    ).not.toBeInTheDocument();
    unmount();

    mockUseActiveUsersMapZoom.mockReturnValue({
      reset: mockReset,
      transform: { k: 2.1, x: 0, y: 0 },
      viewportRef: { current: null },
      zoomBy: mockZoomBy,
    });
    const zoomed = render(
      <ActiveUsersMapPlot countries={[]} onSelect={jest.fn()} />,
    );
    expect(
      zoomed.container.querySelector(
        `img[src="${ACTIVE_USERS_MAP_REGION_ASSET_URL}"]`,
      ),
    ).toBeInTheDocument();
  });
});
