/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  accountAppearancePreference,
  appearanceAccountCookie,
  APPEARANCE_ACCOUNT_STORAGE_KEY,
  APPEARANCE_STORAGE_KEY,
  parseAppearancePreference,
  parseStoredAppearance,
  readStoredAppearance,
  resolveAppearance,
  serializeAppearance,
} from "./appearance";

describe("appearance preferences", () => {
  test.each(["light", "dark", "system"] as const)(
    "accepts %s",
    (preference) => {
      expect(parseAppearancePreference(preference)).toBe(preference);
      expect(parseStoredAppearance(serializeAppearance(preference))).toEqual({
        version: 1,
        preference,
      });
    },
  );

  test.each([undefined, null, true, false, "", "Dark", {}, 1])(
    "rejects %p",
    (value) => {
      expect(parseAppearancePreference(value)).toBeUndefined();
    },
  );

  test("only System follows the OS", () => {
    expect(resolveAppearance("system", true)).toBe("dark");
    expect(resolveAppearance("system", false)).toBe("light");
    expect(resolveAppearance("light", true)).toBe("light");
    expect(resolveAppearance("dark", false)).toBe("dark");
  });

  test("preserves legacy account appearance without masking explicit System", () => {
    expect(accountAppearancePreference({})).toBe("light");
    expect(accountAppearancePreference({ dark_mode: false })).toBe("light");
    expect(accountAppearancePreference({ dark_mode: true })).toBe("dark");
    expect(
      accountAppearancePreference({
        dark_mode: true,
        appearance_theme: "system",
      }),
    ).toBe("system");
    expect(
      accountAppearancePreference({
        dark_mode: true,
        appearance_theme: "invalid",
      }),
    ).toBe("dark");
  });

  test.each([
    "{",
    "null",
    '"dark"',
    '{"version":2,"preference":"dark"}',
    '{"version":1,"preference":"bad"}',
    '{"version":1,"preference":"dark","account_id":false}',
  ])("rejects malformed cache %s", (value) => {
    expect(parseStoredAppearance(value)).toBeUndefined();
  });

  test("cache is scoped to its account, with a separate anonymous preference", () => {
    const data = {
      [APPEARANCE_STORAGE_KEY]: serializeAppearance("system"),
      [APPEARANCE_ACCOUNT_STORAGE_KEY]: serializeAppearance("dark", "alice"),
      "cocalc-essential-theme": "light",
    };
    const storage = { getItem: (key: string) => data[key] ?? null };
    expect(readStoredAppearance(storage, "alice")).toBe("dark");
    expect(readStoredAppearance(storage, "bob")).toBe("system");
    expect(readStoredAppearance(storage, undefined, "essential")).toBe(
      "system",
    );
  });

  test("legacy browser preferences are only used before migration", () => {
    const data: Record<string, string> = {
      "cocalc-essential-theme": "dark",
      "cocalc-scratchpad-dark-mode": "0",
    };
    const storage = { getItem: (key: string) => data[key] ?? null };
    expect(readStoredAppearance(storage)).toBe("system");
    expect(readStoredAppearance(storage, undefined, "essential")).toBe("dark");
    expect(readStoredAppearance(storage, undefined, "scratchpad")).toBe(
      "light",
    );
    data[APPEARANCE_STORAGE_KEY] = serializeAppearance("system");
    expect(readStoredAppearance(storage, undefined, "essential")).toBe(
      "system",
    );
    expect(readStoredAppearance(storage, undefined, "scratchpad")).toBe(
      "system",
    );
  });

  test("blocked storage is harmless", () => {
    expect(
      readStoredAppearance(
        {
          getItem: () => {
            throw Error("blocked");
          },
        },
        "alice",
        "essential",
      ),
    ).toBe("system");
    expect(readStoredAppearance(undefined)).toBe("system");
  });

  test("account cache hint respects base-path cookie boundaries", () => {
    const cookie =
      "account_id=root; %2Fdemoaccount_id=demo; %2Fotheraccount_id=other; not_account_id=bad; %ZZ=bad";
    expect(appearanceAccountCookie(cookie, "/projects")).toBe("root");
    expect(appearanceAccountCookie(cookie, "/demo/projects")).toBe("demo");
    expect(appearanceAccountCookie(cookie, "/demolition")).toBe("root");
    expect(appearanceAccountCookie(cookie, "/other")).toBe("other");
    expect(appearanceAccountCookie("", "/")).toBeUndefined();
  });
});
