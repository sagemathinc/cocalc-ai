/** @jest-environment jsdom */

import {
  clearAllConsentCookies,
  COOKIE_CONSENT_REVISION,
  enableForceConsent,
  restoreConsentCookieFromSnapshot,
  type ConsentSnapshot,
} from "./index";
import { markBannerActive } from "./state";

const show = jest.fn();
let validConsent = false;

jest.mock("vanilla-cookieconsent", () => ({
  acceptedCategory: jest.fn(() => false),
  getCookie: jest.fn(() => null),
  show: (...args: any[]) => show(...args),
  showPreferences: jest.fn(),
  validConsent: () => validConsent,
}));

jest.mock("@cocalc/util/theme", () => ({ COLORS: { GRAY_DD: "#303030" } }), {
  virtual: true,
});

const FORCE_CONSENT_OVERLAY_ID = "cocalc-cookie-consent-force-overlay";

function expireCookie(name: string): void {
  document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`;
}

function getCookieValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return document.cookie
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix))
    ?.slice(prefix.length);
}

beforeEach(() => {
  for (const name of ["cc_cookie", "_ga", "_gid", "CC_ANA"]) {
    expireCookie(name);
  }
  document.body.innerHTML = "";
  document.documentElement.className = "";
  validConsent = false;
  show.mockClear();
  markBannerActive();
});

describe("cookie consent snapshots", () => {
  it("restores a current account snapshot into the runtime consent cookie", () => {
    const snap: ConsentSnapshot = {
      necessary: true,
      analytics: false,
      usage: true,
      revision: COOKIE_CONSENT_REVISION,
      timestamp: "2026-05-19T12:00:00.000Z",
    };

    expect(restoreConsentCookieFromSnapshot(snap)).toBe(true);

    const raw = getCookieValue("cc_cookie");
    expect(raw).toBeDefined();
    const restored = JSON.parse(decodeURIComponent(raw!));
    expect(restored.categories).toEqual(["necessary", "usage"]);
    expect(restored.revision).toBe(COOKIE_CONSENT_REVISION);
    expect(restored.lastConsentTimestamp).toBe(snap.timestamp);
  });

  it("does not restore stale snapshots or overwrite an existing cookie", () => {
    const snap: ConsentSnapshot = {
      necessary: true,
      analytics: true,
      usage: true,
      revision: COOKIE_CONSENT_REVISION - 1,
      timestamp: "2026-05-19T12:00:00.000Z",
    };

    expect(restoreConsentCookieFromSnapshot(snap)).toBe(false);
    expect(getCookieValue("cc_cookie")).toBeUndefined();

    document.cookie = "cc_cookie=existing; path=/; SameSite=Lax";
    expect(
      restoreConsentCookieFromSnapshot({
        ...snap,
        revision: COOKIE_CONSENT_REVISION,
      }),
    ).toBe(false);
    expect(getCookieValue("cc_cookie")).toBe("existing");
  });

  it("clears the consent cookie and registered analytics cookies", () => {
    document.cookie = "cc_cookie=1; path=/; SameSite=Lax";
    document.cookie = "_ga=1; path=/; SameSite=Lax";
    document.cookie = "_gid=1; path=/; SameSite=Lax";
    document.cookie = "CC_ANA=1; path=/; SameSite=Lax";

    clearAllConsentCookies();

    expect(getCookieValue("cc_cookie")).toBeUndefined();
    expect(getCookieValue("_ga")).toBeUndefined();
    expect(getCookieValue("_gid")).toBeUndefined();
    expect(getCookieValue("CC_ANA")).toBeUndefined();
  });
});

describe("forced cookie consent", () => {
  it("blocks the page behind the consent banner until consent changes", () => {
    enableForceConsent();

    const overlay = document.getElementById(FORCE_CONSENT_OVERLAY_ID);
    expect(overlay).not.toBeNull();
    expect(overlay?.style.position).toBe("fixed");
    expect(overlay?.style.pointerEvents).toBe("auto");
    expect(document.documentElement.classList).toContain(
      "disable--interaction",
    );
    expect(show).toHaveBeenCalledWith(true);

    window.dispatchEvent(new Event("cc:onConsent"));

    expect(document.getElementById(FORCE_CONSENT_OVERLAY_ID)).toBeNull();
    expect(document.documentElement.classList).not.toContain(
      "disable--interaction",
    );
  });

  it("keeps the page blocked while another force-consent caller is active", () => {
    const firstCleanup = enableForceConsent();
    const secondCleanup = enableForceConsent();

    firstCleanup();
    expect(document.getElementById(FORCE_CONSENT_OVERLAY_ID)).not.toBeNull();
    expect(document.documentElement.classList).toContain(
      "disable--interaction",
    );

    secondCleanup();
    expect(document.getElementById(FORCE_CONSENT_OVERLAY_ID)).toBeNull();
    expect(document.documentElement.classList).not.toContain(
      "disable--interaction",
    );
  });

  it("does not block the page after essential consent exists", () => {
    validConsent = true;

    enableForceConsent();

    expect(document.getElementById(FORCE_CONSENT_OVERLAY_ID)).toBeNull();
    expect(show).not.toHaveBeenCalled();
  });
});
