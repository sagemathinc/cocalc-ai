/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  getUserLauncherLayers,
  mergeLauncherSettings,
  updateUserLauncherPrefs,
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
    expect(merged.apps).toEqual([
      "jupyterlab",
      "code",
      "jupyter",
      "pluto",
      "rserver",
    ]);
  });

  test("user and project layers can persist explicit ordering", () => {
    const merged = mergeLauncherSettings({
      accountUserPrefs: {
        quickCreateOrder: ["term", "chat", "ipynb", "md", "tex"],
        appsOrder: ["rserver", "jupyterlab", "code", "jupyter", "pluto"],
      },
      projectUserPrefs: {
        quickCreateOrder: ["md", "term", "chat", "ipynb", "tex"],
        appsOrder: ["code", "rserver", "jupyterlab", "jupyter", "pluto"],
      },
    });

    expect(merged.quickCreate).toEqual(["md", "term", "chat", "ipynb", "tex"]);
    expect(merged.apps).toEqual([
      "code",
      "rserver",
      "jupyterlab",
      "jupyter",
      "pluto",
    ]);
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
      quickCreateOrder: [],
      appsOrder: [],
    });
    expect(project).toEqual({
      quickCreate: ["worksheet"],
      hiddenQuickCreate: ["course"],
      apps: ["pluto"],
      hiddenApps: ["jupyter"],
      quickCreateOrder: [],
      appsOrder: [],
    });
  });

  test("round-trips persisted ordering through per-project prefs", () => {
    const settings = updateUserLauncherPrefs({}, "p1", {
      quickCreateOrder: ["term", "chat", "ipynb", "md", "tex"],
      appsOrder: ["code", "jupyterlab", "jupyter", "pluto", "rserver"],
    });
    const { project } = getUserLauncherLayers(settings, "p1");

    expect(project.quickCreateOrder).toEqual([
      "term",
      "chat",
      "ipynb",
      "md",
      "tex",
    ]);
    expect(project.appsOrder).toEqual([
      "code",
      "jupyterlab",
      "jupyter",
      "pluto",
      "rserver",
    ]);
  });
});
