/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { DARK_MODE_DEFAULTS } from "@cocalc/util/db-schema/accounts";
import { getBrowserAppearanceStore } from "@cocalc/util/appearance-browser";

export const DARK_MODE_KEYS = ["brightness", "contrast", "sepia"] as const;

type Config = Record<(typeof DARK_MODE_KEYS)[number], number>;

export const DARK_MODE_MINS: Config = {
  brightness: 30,
  contrast: 30,
  sepia: 0,
} as const;

// Returns number between 0 and 100.
function to_number(x: any, default_value: number): number {
  if (x == null) return default_value;
  try {
    x = parseInt(x);
    if (isNaN(x)) {
      return default_value;
    }
    if (x < 0) {
      x = 0;
    }
    if (x > 100) {
      x = 100;
    }
    return x;
  } catch (_) {
    return default_value;
  }
}

export function get_dark_mode_config(other_settings?: {
  dark_mode_brightness?: number;
  dark_mode_contrast?: number;
  dark_mode_sepia?: number;
}): Config {
  const config = {} as Config;

  for (const key of DARK_MODE_KEYS) {
    config[key] = Math.max(
      DARK_MODE_MINS[key],
      to_number(other_settings?.[`dark_mode_${key}`], DARK_MODE_DEFAULTS[key]),
    );
  }

  return config;
}

export function inDarkMode() {
  return getBrowserAppearanceStore().getSnapshot().resolved === "dark";
}
