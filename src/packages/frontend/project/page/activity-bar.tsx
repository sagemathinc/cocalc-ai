/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type ActivityBarOption = "flyout";

export function getValidActivityBarOption(
  _activityBarSetting: any,
): ActivityBarOption {
  return "flyout";
}
