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
      },
      projectDefaults: {
        quickCreate: ["paper"],
        hiddenQuickCreate: ["chat"],
      },
      accountUserPrefs: {
        quickCreate: ["codex"],
        hiddenQuickCreate: ["term"],
      },
      projectUserPrefs: {
        quickCreate: ["worksheet"],
        hiddenQuickCreate: ["course"],
      },
    });

    expect(merged.quickCreate).toEqual([
      "ipynb",
      "md",
      "paper",
      "codex",
      "worksheet",
    ]);
  });

  test("quick create allows arbitrary extensions", () => {
    const merged = mergeLauncherSettings({
      globalDefaults: {
        quickCreate: ["course", "codex", "totally-custom"],
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
  });

  test("user and project layers can persist explicit ordering", () => {
    const merged = mergeLauncherSettings({
      accountUserPrefs: {
        quickCreateOrder: ["term", "chat", "ipynb", "md", "tex"],
      },
      projectUserPrefs: {
        quickCreateOrder: ["md", "term", "chat", "ipynb", "tex"],
      },
    });

    expect(merged.quickCreate).toEqual(["md", "term", "chat", "ipynb", "tex"]);
  });
});

describe("getUserLauncherLayers", () => {
  test("splits account and per-project user layers", () => {
    const settings = {
      quickCreate: ["course"],
      hiddenQuickCreate: ["tex"],
      perProject: {
        p1: {
          quickCreate: ["worksheet"],
          hiddenQuickCreate: ["course"],
        },
      },
    };
    const { account, project } = getUserLauncherLayers(settings, "p1");
    expect(account).toEqual({
      quickCreate: ["course"],
      hiddenQuickCreate: ["tex"],
      quickCreateOrder: [],
    });
    expect(project).toEqual({
      quickCreate: ["worksheet"],
      hiddenQuickCreate: ["course"],
      quickCreateOrder: [],
    });
  });

  test("round-trips persisted ordering through per-project prefs", () => {
    const settings = updateUserLauncherPrefs({}, "p1", {
      quickCreateOrder: ["term", "chat", "ipynb", "md", "tex"],
    });
    const { project } = getUserLauncherLayers(settings, "p1");

    expect(project.quickCreateOrder).toEqual([
      "term",
      "chat",
      "ipynb",
      "md",
      "tex",
    ]);
  });

  test("updating account prefs strips legacy launcher app fields", () => {
    const settings = updateUserLauncherPrefs(
      {
        apps: ["jupyterlab"],
        hiddenApps: ["code"],
        appsOrder: ["jupyterlab"],
      },
      undefined,
      {
        quickCreate: ["course"],
      },
    );

    expect(settings).toEqual({
      quickCreate: ["course"],
      hiddenQuickCreate: [],
      quickCreateOrder: [],
    });
  });
});
