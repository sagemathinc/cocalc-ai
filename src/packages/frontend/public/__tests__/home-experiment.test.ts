/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { hasCategoryConsent } from "@cocalc/frontend/cookie-consent";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  choosePublicHomeVariant,
  publicHomeExperimentAllowed,
  publicHomeVariantFromSearch,
  followWithPublicHomeVariant,
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
  it("posts one aggregate event with fetch, without cookies", async () => {
    const sendBeacon = jest.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: sendBeacon,
    });
    const fetch = jest.fn(async () => ({ ok: true }));
    (window as any).fetch = fetch;
    expect(await sendPublicHomeExperimentEvent("math", "view")).toBe(true);
    // sendBeacon would send cookies: never used.
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as any;
    expect(url).toMatch(/home-experiment$/);
    expect(JSON.parse(init.body)).toEqual({ variant: "math", event: "view" });
    expect(init.credentials).toBe("omit");
    expect(init.keepalive).toBe(true);
  });

  it("reports false when the event was not stored", async () => {
    (window as any).fetch = jest.fn(async () => ({ ok: false, status: 429 }));
    expect(await sendPublicHomeExperimentEvent("math", "view")).toBe(false);
    (window as any).fetch = jest.fn(async () => ({ ok: false, status: 503 }));
    expect(await sendPublicHomeExperimentEvent("math", "cta")).toBe(false);
    (window as any).fetch = jest.fn(async () => {
      throw Error("network down");
    });
    expect(await sendPublicHomeExperimentEvent("math", "view")).toBe(false);
  });
});

describe("usePublicHomeSignupVariant", () => {
  it("adds the version only after consent, and re-renders when it is given", async () => {
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
    await waitFor(() => expect(result.current()).toBe("math"));
    expect(fetch).toHaveBeenCalledTimes(1);
    act(() => consentListeners.forEach((cb) => cb()));
    expect(fetch).toHaveBeenCalledTimes(1);
    window.history.replaceState(null, "", "/");
  });

  it("needs no consent on sites without the cookie banner", async () => {
    window.history.replaceState(null, "", "/auth/sign-up?home=math");
    (window as any).fetch = jest.fn(async () => ({ ok: true }));
    jest.mocked(hasCategoryConsent).mockReturnValue(false);
    const { result } = renderHook(() => usePublicHomeSignupVariant(false));
    await waitFor(() => expect(result.current()).toBe("math"));
    window.history.replaceState(null, "", "/");
  });

  it("withholds the version when the visit was not stored", async () => {
    window.history.replaceState(null, "", "/auth/sign-up?home=math");
    const fetch = jest.fn(async () => ({ ok: false, status: 429 }));
    (window as any).fetch = fetch;
    const { result } = renderHook(() => usePublicHomeSignupVariant(false));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(result.current()).toBeUndefined();
    window.history.replaceState(null, "", "/");
  });
});

describe("a sign-up that leaves before the visit is stored", () => {
  function deferredFetch() {
    let resolve!: (value: { ok: boolean }) => void;
    const fetch = jest.fn(
      () =>
        new Promise<{ ok: boolean }>((next) => {
          resolve = next;
        }),
    );
    (window as any).fetch = fetch;
    return { fetch, resolve: (ok: boolean) => resolve({ ok }) };
  }

  it("waits for the visit, then sends the version", async () => {
    window.history.replaceState(null, "", "/auth/sign-up?home=math");
    const visit = deferredFetch();
    const { result } = renderHook(() => usePublicHomeSignupVariant(false));
    expect(result.current.pending()).toBe(true);
    expect(result.current()).toBeUndefined();
    const settled = result.current.settled();
    await act(async () => visit.resolve(true));
    expect(await settled).toBe("math");
    expect(result.current.pending()).toBe(false);
    window.history.replaceState(null, "", "/");
  });

  it("sends no version when the visit was not stored", async () => {
    window.history.replaceState(null, "", "/auth/sign-up?home=math");
    const visit = deferredFetch();
    const { result } = renderHook(() => usePublicHomeSignupVariant(false));
    const settled = result.current.settled();
    await act(async () => visit.resolve(false));
    expect(await settled).toBeUndefined();
    window.history.replaceState(null, "", "/");
  });

  it("holds a single sign-on click until the visit is stored, then follows with the version", async () => {
    let finish!: (variant: string | undefined) => void;
    const homeVariant = Object.assign(() => undefined, {
      pending: () => true,
      settled: () =>
        new Promise<string | undefined>((next) => {
          finish = next;
        }),
    });
    const navigate = jest.fn();
    const event = {
      preventDefault: jest.fn(),
      currentTarget: { href: "https://cocalc.test/auth/google?terms=true" },
    };
    followWithPublicHomeVariant(event, homeVariant, navigate);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => finish("math"));
    expect(navigate).toHaveBeenCalledWith(
      "https://cocalc.test/auth/google?terms=true&home_variant=math",
    );
  });

  it("lets a click through when nothing is pending", () => {
    const homeVariant = Object.assign(() => "math", {
      pending: () => false,
      settled: async () => "math",
    });
    const event = { preventDefault: jest.fn(), currentTarget: { href: "x" } };
    followWithPublicHomeVariant(event, homeVariant);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
