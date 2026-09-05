import { renderHook } from "@testing-library/react";
import { useAntdStyleProvider } from "./context";
import { getBaseAntdTheme } from "./antd-base-theme";
import { theme as antdTheme } from "antd";
import { appearancePalette } from "@cocalc/util/appearance-palette";

jest.mock("@cocalc/frontend/app-framework", () => ({
  useAccountOtherSetting: () => false,
}));
jest.mock("@cocalc/frontend/appearance/use-appearance", () => ({
  useAppearance: () => ({ resolved: "dark" }),
}));
jest.mock("./animations", () => ({ useAnimationsEnabled: () => false }));
jest.mock("@cocalc/frontend/project/page/activity-bar-storage", () => ({
  useActivityBarPreferences: () => ({ labels: true }),
}));

it("preserves shared button contrast overrides when applying account styling", () => {
  const { result } = renderHook(() => useAntdStyleProvider());
  expect(result.current.antdTheme.components?.Button).toEqual(
    expect.objectContaining(getBaseAntdTheme("dark").components!.Button),
  );
  expect(result.current.antdTheme.token?.motion).toBe(false);
  expect(result.current.antdTheme.components?.Menu).toEqual(
    getBaseAntdTheme("dark").components!.Menu,
  );
});

it.each(["Success", "Info", "Warning", "Error"])(
  "uses official light alert %s colors without changing dark alerts",
  (status) => {
    const defaults = antdTheme.getDesignToken();
    const alert = getBaseAntdTheme("light").components!.Alert!;
    for (const suffix of ["", "Bg", "Border"]) {
      const key = `color${status}${suffix}`;
      expect(alert[key]).toBe(defaults[key]);
    }
    expect(getBaseAntdTheme("dark").components?.Alert).toBeUndefined();
  },
);

it("preserves the original light-mode success tint and button text", () => {
  const theme = getBaseAntdTheme("light");
  expect(theme.token?.colorSuccessBg).toBe("#f6ffed");
  expect(theme.components?.Button?.defaultColor).toBe("#000000e0");
  expect(theme.components?.Button?.textTextColor).toBe("#000000e0");
});

it("uses readable selected submenu and pagination colors only in dark mode", () => {
  const dark = getBaseAntdTheme("dark").components!;
  expect(dark.Menu?.subMenuItemSelectedColor).toBe(
    appearancePalette("dark").link,
  );
  expect(dark.Pagination?.colorPrimary).toBe(appearancePalette("dark").link);
  expect(getBaseAntdTheme("light").components?.Pagination).toBeUndefined();
});

it.each(["light", "dark"] as const)(
  "keeps ghost buttons readable on branded %s backgrounds",
  (mode) => {
    const button = getBaseAntdTheme(mode).components!.Button!;
    expect(button.defaultGhostColor).toBe(appearancePalette(mode).onPrimary);
    expect(button.defaultGhostBorderColor).toBe(
      appearancePalette(mode).onPrimary,
    );
  },
);
