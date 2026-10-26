/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { hasCategoryConsent } from "@cocalc/frontend/cookie-consent";
import { act, renderHook } from "@testing-library/react";
import {
  choosePublicHomeVariant,
  publicHomeExperimentAllowed,
  publicHomeVariantFromSearch,
  sendPublicHomeExperimentEvent,
  usePublicHomeSignupVariant,
} from "../home-experiment";

let consentListeners: Array<() => void> = [];
jest.mock("@cocalc/frontend/cookie-consent", () => ({
  hasCategoryConsent: jest.fn(() => false),
  onConsentChange: jest.fn((cb: () => void) => {
    consentListeners.push(cb);
    return () => {
      consentListeners = consentListeners.filter((x) => x !== cb);
    };
  }),
}));

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

describe("consent", () => {
  it("counts only with usage consent on sites with the cookie banner", () => {
    jest.mocked(hasCategoryConsent).mockReturnValue(false);
    expect(publicHomeExperimentAllowed(true)).toBe(false);
    expect(publicHomeExperimentAllowed(false)).toBe(true);
    jest.mocked(hasCategoryConsent).mockReturnValue(true);
    expect(publicHomeExperimentAllowed(true)).toBe(true);
    expect(hasCategoryConsent).toHaveBeenCalledWith("usage");
  });
});

describe("sendPublicHomeExperimentEvent", () => {
  it("posts one aggregate event with fetch, without cookies", () => {
    const sendBeacon = jest.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: sendBeacon,
    });
    const fetch = jest.fn(async () => ({ ok: true }));
    (window as any).fetch = fetch;
    sendPublicHomeExperimentEvent("math", "view");
    // sendBeacon would send cookies: never used.
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as any;
    expect(url).toMatch(/home-experiment$/);
    expect(JSON.parse(init.body)).toEqual({ variant: "math", event: "view" });
    expect(init.credentials).toBe("omit");
    expect(init.keepalive).toBe(true);
  });
});

describe("usePublicHomeSignupVariant", () => {
  it("adds the version only after consent, and re-renders when it is given", () => {
    window.history.replaceState(null, "", "/auth/sign-up?home=math");
    const fetch = jest.fn(async () => ({ ok: true }));
    (window as any).fetch = fetch;
    jest.mocked(hasCategoryConsent).mockReturnValue(false);
    const { result } = renderHook(() => usePublicHomeSignupVariant(true));
    // Refused or not decided: no version on links, nothing counted.
    expect(result.current()).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    // Consent given later: the next render's links carry the version, and
    // the visit is counted once.
    jest.mocked(hasCategoryConsent).mockReturnValue(true);
    act(() => consentListeners.forEach((cb) => cb()));
    expect(result.current()).toBe("math");
    expect(fetch).toHaveBeenCalledTimes(1);
    act(() => consentListeners.forEach((cb) => cb()));
    expect(fetch).toHaveBeenCalledTimes(1);
    window.history.replaceState(null, "", "/");
  });

  it("needs no consent on sites without the cookie banner", () => {
    window.history.replaceState(null, "", "/auth/sign-up?home=math");
    (window as any).fetch = jest.fn(async () => ({ ok: true }));
    jest.mocked(hasCategoryConsent).mockReturnValue(false);
    const { result } = renderHook(() => usePublicHomeSignupVariant(false));
    expect(result.current()).toBe("math");
    window.history.replaceState(null, "", "/");
  });
});
