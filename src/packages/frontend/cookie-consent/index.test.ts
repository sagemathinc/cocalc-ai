/** @jest-environment jsdom */

import {
  clearAllConsentCookies,
  COOKIE_CONSENT_REVISION,
  restoreConsentCookieFromSnapshot,
  type ConsentSnapshot,
} from "./index";

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
