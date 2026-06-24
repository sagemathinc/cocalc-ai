/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import express, { type Router } from "express";

import stripeWebhookHandler from "@cocalc/server/purchases/stripe/webhook";

export default function initStripeWebhook(router: Router) {
  router.post(
    "/webhooks/stripe",
    express.raw({ type: "application/json", limit: "2mb" }),
    stripeWebhookHandler,
  );
}
