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
});
