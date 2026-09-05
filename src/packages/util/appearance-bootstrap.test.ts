/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { runInNewContext } from "node:vm";
import {
  appearanceBootstrapScript,
  appearanceHeadHtml,
} from "./appearance-bootstrap";
import {
  APPEARANCE_ACCOUNT_STORAGE_KEY,
  APPEARANCE_STORAGE_KEY,
  appearanceAccountCookie,
  readStoredAppearance,
  resolveAppearance,
  serializeAppearance,
} from "./appearance";
import { appearancePalette, appearanceStyleSheet } from "./appearance-palette";

test("bootstrap matches runtime for all modes, legacy entries, cookies, and storage failures", () => {
  for (const stored of [
    null,
    "{",
    serializeAppearance("system"),
    serializeAppearance("dark"),
    serializeAppearance("light"),
    '{"version":1,"preference":"dark","account_id":false}',
  ]) {
    for (const legacy of [undefined, "essential", "scratchpad"] as const) {
      for (const dark of [false, true]) {
        for (const cookie of [
          "",
          "account_id=alice",
          "%2Fdemoaccount_id=alice",
          "account_id=bob; %2Fotheraccount_id=alice",
        ]) {
          for (const blocked of [false, true]) {
            const entries = {
              [APPEARANCE_STORAGE_KEY]: stored,
              [APPEARANCE_ACCOUNT_STORAGE_KEY]: serializeAppearance(
                "light",
                "alice",
              ),
              "cocalc-essential-theme": "dark",
              "cocalc-scratchpad-dark-mode": "0",
            };
            const storage = {
              getItem: (key: string) => {
                if (blocked) throw Error("blocked");
                return entries[key] ?? null;
              },
            };
            const attributes = new Map<string, string>();
            const root = {
              setAttribute: (key: string, value: string) =>
                attributes.set(key, value),
              style: { colorScheme: "" },
            };
            const pathname = "/demo/projects";
            runInNewContext(appearanceBootstrapScript(legacy), {
              document: { cookie, documentElement: root },
              location: { pathname },
              localStorage: storage,
              window: { matchMedia: () => ({ matches: dark }) },
            });
            const expected = resolveAppearance(
              readStoredAppearance(
                storage,
                appearanceAccountCookie(cookie, pathname),
                legacy,
              ),
              dark,
            );
            expect(attributes.get("data-cocalc-theme")).toBe(expected);
            expect(root.style.colorScheme).toBe(expected);
          }
        }
      }
    }
  }
});

test("storage and media APIs may be completely absent", () => {
  const root = { setAttribute: jest.fn(), style: {} };
  runInNewContext(appearanceBootstrapScript(), {
    window: {},
    document: { documentElement: root },
    location: { pathname: "/" },
  });
  expect(root.setAttribute).toHaveBeenCalledWith("data-cocalc-theme", "light");
});

test("initial CSS contains both palettes, no-script OS fallback, and light print rules", () => {
  const css = appearanceStyleSheet();
  for (const mode of ["light", "dark"] as const) {
    for (const [name, color] of Object.entries(appearancePalette(mode))) {
      expect(css).toContain(`--cocalc-ui-${name}:${color}`);
    }
  }
  expect(css).toContain("prefers-color-scheme:dark");
  expect(css).toContain("@media print");
  expect(appearanceHeadHtml()).toContain('id="cocalc-appearance-tokens"');
  expect(appearanceHeadHtml()).not.toContain("darkreader");
});

function luminance(color: string): number {
  const components = color
    .slice(1)
    .match(/../g)!
    .map((v) => {
      const channel = parseInt(v, 16) / 255;
      return channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4;
    });
  return (
    components[0] * 0.2126 + components[1] * 0.7152 + components[2] * 0.0722
  );
}

function contrast(first: string, second: string): number {
  const a = luminance(first),
    b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test.each(["light", "dark"] as const)(
  "%s semantic text/status pairs meet AA contrast",
  (mode) => {
    const p = appearancePalette(mode);
    for (const foreground of [p.text, p.secondary, p.muted, p.link]) {
      for (const background of [p.page, p.surface, p.elevated, p.inset]) {
        expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const role of ["success", "warning", "danger", "info"] as const) {
      expect(contrast(p[role], p[`${role}Bg`])).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(p.onPrimary, p.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.focus, p.surface)).toBeGreaterThanOrEqual(3);
  },
);
