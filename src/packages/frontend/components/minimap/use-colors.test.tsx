import { renderHook } from "@testing-library/react";
import { useMinimapColors } from "./use-colors";
import { MINIMAP_COLORS } from "./colors";

let mockResolved = "light";
jest.mock("@cocalc/frontend/appearance/use-appearance", () => ({
  useAppearance: () => ({ resolved: mockResolved }),
}));

it("updates concrete canvas colors on appearance changes", () => {
  const { result, rerender } = renderHook(useMinimapColors);
  expect(result.current.colors).toBe(MINIMAP_COLORS);
  mockResolved = "dark";
  rerender();
  const dark = result.current;
  expect(dark.colors.block).not.toBe(MINIMAP_COLORS.block);
  expect(dark.colors.current).not.toBe(MINIMAP_COLORS.current);
  expect(dark.colors.canvasBackground).not.toBe(
    MINIMAP_COLORS.canvasBackground,
  );
  for (const color of [
    dark.colors.canvasBackground,
    ...Object.values(dark.syntax),
    ...Object.values(dark.cells.code),
  ]) {
    expect(color).not.toContain("var(");
  }
  rerender();
  expect(result.current).toBe(dark);
  mockResolved = "light";
  rerender();
  expect(result.current.colors).toBe(MINIMAP_COLORS);
});
