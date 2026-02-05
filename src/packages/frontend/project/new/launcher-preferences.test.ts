/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  getUserLauncherLayers,
  mergeLauncherSettings,
} from "./launcher-preferences";

describe("launcher additive merge", () => {
  test("applies layers in order using additive and explicit removals", () => {
    const merged = mergeLauncherSettings({
      globalDefaults: {
        quickCreate: ["course"],
        hiddenQuickCreate: ["tex"],
        apps: ["xpra"],
        hiddenApps: ["jupyter"],
      },
      projectDefaults: {
        quickCreate: ["paper"],
        hiddenQuickCreate: ["chat"],
        apps: ["jupyter"],
      },
      accountUserPrefs: {
        quickCreate: ["codex"],
        hiddenQuickCreate: ["term"],
        apps: ["pluto"],
        hiddenApps: ["xpra"],
      },
      projectUserPrefs: {
        quickCreate: ["worksheet"],
        hiddenQuickCreate: ["course"],
        apps: ["code"],
        hiddenApps: ["jupyterlab"],
      },
    });

    expect(merged.quickCreate).toEqual([
      "ipynb",
      "md",
      "paper",
      "codex",
      "worksheet",
    ]);
    expect(merged.apps).toEqual(["code", "pluto", "rserver", "jupyter"]);
  });

  test("quick create allows arbitrary extensions, apps remain validated", () => {
    const merged = mergeLauncherSettings({
      globalDefaults: {
        quickCreate: ["course", "codex", "totally-custom"],
        apps: ["not-a-real-app"],
      },
    });
    expect(merged.quickCreate).toEqual([
      "chat",
      "ipynb",
      "md",
      "tex",
      "term",
      "course",
      "codex",
      "totally-custom",
    ]);
    expect(merged.apps).toEqual(["jupyterlab", "code", "jupyter", "pluto", "rserver"]);
  });
});

describe("getUserLauncherLayers", () => {
  test("splits account and per-project user layers", () => {
    const settings = {
      quickCreate: ["course"],
      hiddenQuickCreate: ["tex"],
      apps: ["jupyter"],
      hiddenApps: ["code"],
      perProject: {
        p1: {
          quickCreate: ["worksheet"],
          hiddenQuickCreate: ["course"],
          apps: ["pluto"],
          hiddenApps: ["jupyter"],
        },
      },
    };
    const { account, project } = getUserLauncherLayers(settings, "p1");
    expect(account).toEqual({
      quickCreate: ["course"],
      hiddenQuickCreate: ["tex"],
      apps: ["jupyter"],
      hiddenApps: ["code"],
    });
    expect(project).toEqual({
      quickCreate: ["worksheet"],
      hiddenQuickCreate: ["course"],
      apps: ["pluto"],
      hiddenApps: ["jupyter"],
    });
  });
});
