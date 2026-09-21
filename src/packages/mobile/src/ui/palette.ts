/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { useColorScheme } from "react-native";
import { appearancePalette } from "@cocalc/util/appearance-palette";

// Native controls require concrete colors, not UI_COLORS' CSS variable strings.
export function usePalette() {
  return appearancePalette(useColorScheme() === "dark" ? "dark" : "light");
}
