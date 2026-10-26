/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  choosePublicHomeVariant,
  publicHomeVariantFromSearch,
  sendPublicHomeExperimentEvent,
} from "../home-experiment";

jest.mock("@cocalc/util/public-home-experiment", () => {
  const actual = jest.requireActual("@cocalc/util/public-home-experiment");
  const known = ["default", "math", "project"];
  return {
    ...actual,
    isPublicHomeVariantId: (id: unknown) =>
      actual.isPublicHomeVariantId(id, known),
    parsePublicHomeExperimentArms: (value: unknown) =>
      actual.parsePublicHomeExperimentArms(value, known),
  };
});

describe("choosePublicHomeVariant", () => {
  const setting = "default:1, math:1";

  it("picks a counted version for an anonymous visit while the experiment runs", () => {
    expect(
      choosePublicHomeVariant({
        setting,
        isAuthenticated: false,
        search: "",
        random: () => 0.75,
      }),
    ).toEqual({ variant: "math", counted: true });
  });

  it("shows signed-in visitors the default, uncounted", () => {
    expect(
      choosePublicHomeVariant({
        setting,
        isAuthenticated: true,
        search: "",
        random: () => 0.75,
      }),
    ).toEqual({ variant: "default", counted: false });
  });

  it("shows the default, uncounted, while the experiment is off", () => {
    expect(
      choosePublicHomeVariant({
        setting: "",
        isAuthenticated: false,
        search: "",
      }),
    ).toEqual({ variant: "default", counted: false });
  });

  it("previews a known version with ?home=, uncounted, even when off", () => {
    expect(
      choosePublicHomeVariant({
        setting: "",
        isAuthenticated: true,
        search: "?home=project",
      }),
    ).toEqual({ variant: "project", counted: false });
    expect(
      choosePublicHomeVariant({
        setting: "",
        isAuthenticated: false,
        search: "?home=unknown",
      }),
    ).toEqual({ variant: "default", counted: false });
  });
});

describe("the sign-up page's version", () => {
  it("reads only known versions from the link", () => {
    expect(publicHomeVariantFromSearch("?home=math")).toBe("math");
    expect(publicHomeVariantFromSearch("?home=evil<script>")).toBeUndefined();
    expect(publicHomeVariantFromSearch("")).toBeUndefined();
  });
});

describe("sendPublicHomeExperimentEvent", () => {
  it("sends one aggregate event without credentials", async () => {
    const sendBeacon = jest.fn(() => false);
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: sendBeacon,
    });
    const fetch = jest.fn(async () => ({ ok: true }));
    (window as any).fetch = fetch;
    sendPublicHomeExperimentEvent("math", "view");
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as any;
    expect(url).toMatch(/home-experiment$/);
    expect(JSON.parse(init.body)).toEqual({ variant: "math", event: "view" });
    expect(init.credentials).toBe("omit");
  });
});
