/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  getAccountLauncherPrefs,
  getEffectiveLauncher,
  getSiteLauncherDefaults,
  LAUNCHER_GLOBAL_DEFAULTS,
  updateAccountLauncherPrefs,
} from "./launcher-preferences";

describe("launcher exact-list preferences", () => {
  test("uses account list before site list before built-in defaults", () => {
    expect(
      getEffectiveLauncher({
        accountPrefs: { quickCreate: ["term"] },
        siteDefaults: { quickCreate: ["chat", "ipynb"] },
      }).quickCreate,
    ).toEqual(["term"]);

    expect(
      getEffectiveLauncher({
        siteDefaults: { quickCreate: ["chat", "ipynb"] },
      }).quickCreate,
    ).toEqual(["chat", "ipynb"]);

    expect(getEffectiveLauncher({}).quickCreate).toEqual(
      LAUNCHER_GLOBAL_DEFAULTS.quickCreate,
    );
  });

  test("normalizes site defaults as an exact ordered list", () => {
    expect(getSiteLauncherDefaults([" chat ", "ipynb", "chat"])).toEqual({
      quickCreate: ["chat", "ipynb"],
    });
  });

  test("reads account prefs and ignores legacy per-project layers", () => {
    expect(
      getAccountLauncherPrefs({
        quickCreate: ["term"],
        perProject: {
          p1: {
            quickCreate: ["chat"],
          },
        },
      }),
    ).toEqual({ quickCreate: ["term"] });
  });

  test("updating account prefs strips legacy launcher fields", () => {
    expect(
      updateAccountLauncherPrefs(
        {
          apps: ["jupyterlab"],
          hiddenApps: ["code"],
          appsOrder: ["jupyterlab"],
          hiddenQuickCreate: ["tex"],
          quickCreateOrder: ["term"],
          perProject: {
            p1: {
              quickCreate: ["chat"],
            },
          },
        },
        {
          quickCreate: ["term", "chat", "term"],
        },
      ),
    ).toEqual({
      quickCreate: ["term", "chat"],
    });
  });

  test("resetting account prefs removes the exact-list override", () => {
    expect(
      updateAccountLauncherPrefs(
        {
          quickCreate: ["term"],
          unrelated: true,
        },
        null,
      ),
    ).toEqual({
      unrelated: true,
    });
  });
});
