/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

/** The bay's clock for sponsored-restart expiry decisions. Tests replace it to
 * age a stored restart request without moving the payer's clock. */
export const restartClock = { now: () => Date.now() };
