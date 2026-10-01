/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
// Admission and handoff must agree on the maximum new canonical state. Reserve
// this capacity in addition to the pre-existing personal/catalog/graph budgets.
export const MAX_PROJECT_NOTIFICATION_SUBSCRIPTIONS = 10_000;
export const PROJECT_NOTIFICATION_SUBSCRIPTION_BYTES = 4 * 1024 * 1024;
export const MAX_ACCOUNT_SUMMARY_RECEIPTS = 10_000;
export const ACCOUNT_NOTIFICATION_RETENTION_BYTES = 8 * 1024 * 1024;
