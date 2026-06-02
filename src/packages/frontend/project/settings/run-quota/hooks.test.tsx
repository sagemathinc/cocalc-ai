/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";

import {
  KUCALC_DISABLED,
  KUCALC_ON_PREMISES,
} from "@cocalc/util/db-schema/site-defaults";
import { useDisplayedFields } from "./hooks";

let mockKucalc = KUCALC_DISABLED;

jest.mock("@cocalc/frontend/app-framework", () => ({
  useEffect: require("react").useEffect,
  useMemo: require("react").useMemo,
  useState: require("react").useState,
  useTypedRedux: (store: string, key: string) => {
    if (store === "customize" && key === "kucalc") {
      return mockKucalc;
    }
    return undefined;
  },
}));

function DisplayedFields() {
  return <div>{useDisplayedFields().join(",")}</div>;
}

describe("run quota displayed fields", () => {
  it("shows cocalc-ai baseline fields when legacy kucalc is disabled", () => {
    mockKucalc = KUCALC_DISABLED;

    render(<DisplayedFields />);

    expect(screen.getByText("disk_quota,memory")).toBeTruthy();
  });

  it("adds on-premises-only extras for on-premises deployments", () => {
    mockKucalc = KUCALC_ON_PREMISES;

    render(<DisplayedFields />);

    expect(screen.getByText("disk_quota,memory,ext_rw,patch,gpu")).toBeTruthy();
  });
});
