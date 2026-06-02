/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";

import {
  PLATFORM_MODE_SINGLE_NODE,
  PLATFORM_MODE_ON_PREMISES,
} from "@cocalc/util/db-schema/site-defaults";
import { useDisplayedFields } from "./hooks";

let mockPlatformMode = PLATFORM_MODE_SINGLE_NODE;

jest.mock("@cocalc/frontend/app-framework", () => ({
  useEffect: require("react").useEffect,
  useMemo: require("react").useMemo,
  useState: require("react").useState,
  useTypedRedux: (store: string, key: string) => {
    if (store === "customize" && key === "platform_mode") {
      return mockPlatformMode;
    }
    return undefined;
  },
}));

function DisplayedFields() {
  return <div>{useDisplayedFields().join(",")}</div>;
}

describe("run quota displayed fields", () => {
  it("shows cocalc-ai baseline fields on single-node deployments", () => {
    mockPlatformMode = PLATFORM_MODE_SINGLE_NODE;

    render(<DisplayedFields />);

    expect(screen.getByText("disk_quota,memory")).toBeTruthy();
  });

  it("adds on-premises-only extras for on-premises deployments", () => {
    mockPlatformMode = PLATFORM_MODE_ON_PREMISES;

    render(<DisplayedFields />);

    expect(screen.getByText("disk_quota,memory,ext_rw,patch,gpu")).toBeTruthy();
  });
});
