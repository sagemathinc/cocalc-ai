/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// For tests only (an enumeration test keeps it out of production code): a
// capability that satisfies a method's entry check (requireKeyUse) and that
// every decrypt admission refuses. Tests that read a real key make real
// records (admitUserKeyUse) instead.

import {
  issueTestKeyUse,
  type GpuKeyUse,
  type GpuKeyUsePurpose,
} from "@cocalc/server/gpu/key-use";

export function testKeyUse(purpose: GpuKeyUsePurpose): GpuKeyUse {
  return issueTestKeyUse(purpose);
}
