import { renderHook } from "@testing-library/react";
import { useAntdStyleProvider } from "./context";
import { getBaseAntdTheme } from "./antd-base-theme";

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

it("preserves the original light-mode success tint and button text", () => {
  const theme = getBaseAntdTheme("light");
  expect(theme.token?.colorSuccessBg).toBe("#f6ffed");
  expect(theme.components?.Button?.defaultColor).toBe("#000000e0");
  expect(theme.components?.Button?.textTextColor).toBe("#000000e0");
});
