/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
// get a subarray of all values between the two given values inclusive,
// provided in either order
export function get_array_range(arr: any[], value1: any, value2: any): any[] {
  let index1 = arr.indexOf(value1);
  let index2 = arr.indexOf(value2);
  if (index1 > index2) {
    [index1, index2] = [index2, index1];
  }
  return arr.slice(index1, +index2 + 1 || undefined);
}
