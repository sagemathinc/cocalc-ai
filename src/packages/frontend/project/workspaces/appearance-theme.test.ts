/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { Map } from "immutable";
import { FOLLOW_APPEARANCE } from "@cocalc/util/appearance-editor";
import {
  effectiveEditorThemeName,
  effectiveImmutableEditorSettings,
  effectivePlainEditorSettings,
} from "./editor-theme";
import { effectiveTerminalColorScheme } from "./terminal-theme";

describe.each(["light", "dark"] as const)("%s appearance", (appearance) => {
  test("only explicit Follow resolves dynamically, with workspace precedence", () => {
    for (const settings of [
      { theme: FOLLOW_APPEARANCE },
      Map({ theme: FOLLOW_APPEARANCE }),
    ]) {
      expect(effectiveEditorThemeName(settings, undefined, appearance)).toBe(
        `cocalc-${appearance}`,
      );
      expect(
        effectiveEditorThemeName(
          settings,
          { editor_theme: "monokai" },
          appearance,
        ),
      ).toBe("monokai");
    }
    expect(
      effectiveEditorThemeName({ theme: "default" }, undefined, appearance),
    ).toBe("default");
    expect(effectiveEditorThemeName({}, undefined, appearance)).toBeNull();
    expect(
      effectiveEditorThemeName(
        { theme: "monokai" },
        { editor_theme: FOLLOW_APPEARANCE },
        appearance,
      ),
    ).toBe(`cocalc-${appearance}`);
  });

  test("resolved editor settings leave saved choices and unrelated options intact", () => {
    const settings = { theme: FOLLOW_APPEARANCE, tab_size: 3 };
    expect(
      effectivePlainEditorSettings(settings, undefined, appearance),
    ).toEqual({ theme: `cocalc-${appearance}`, tab_size: 3 });
    const immutable = Map(settings);
    expect(
      effectiveImmutableEditorSettings(immutable, undefined, appearance).toJS(),
    ).toEqual({ theme: `cocalc-${appearance}`, tab_size: 3 });
    expect(immutable.get("theme")).toBe(FOLLOW_APPEARANCE);
    expect(settings.theme).toBe(FOLLOW_APPEARANCE);
    const explicit = Map({ theme: "cocalc-light" });
    expect(
      effectiveImmutableEditorSettings(explicit, undefined, appearance),
    ).toBe(explicit);
  });

  test("terminal Follow does not override saved account or workspace palettes", () => {
    const follow = Map({ color_scheme: FOLLOW_APPEARANCE });
    expect(effectiveTerminalColorScheme(follow, undefined, appearance)).toBe(
      `cocalc-${appearance}`,
    );
    expect(
      effectiveTerminalColorScheme(
        follow,
        { terminal_theme: "solarized-dark" },
        appearance,
      ),
    ).toBe("solarized-dark");
    expect(
      effectiveTerminalColorScheme(
        Map({ color_scheme: "default" }),
        undefined,
        appearance,
      ),
    ).toBe("default");
    expect(effectiveTerminalColorScheme(undefined, undefined, appearance)).toBe(
      "default",
    );
    expect(
      effectiveTerminalColorScheme(
        Map({ color_scheme: "default" }),
        { terminal_theme: FOLLOW_APPEARANCE },
        appearance,
      ),
    ).toBe(`cocalc-${appearance}`);
  });
});
