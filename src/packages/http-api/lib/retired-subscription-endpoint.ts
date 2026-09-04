/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export const RETIRED_SUBSCRIPTION_ENDPOINT_ERROR =
  "This legacy subscription endpoint is no longer supported. Manage your personal membership in account settings.";

export default function retiredSubscriptionEndpoint(_req, res): void {
  res.status(410).json({
    error: RETIRED_SUBSCRIPTION_ENDPOINT_ERROR,
    code: "legacy_subscription_endpoint_retired",
  });
}
