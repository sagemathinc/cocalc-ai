/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The stripe connection object, which communicates with the remote stripe server.

Configure via the admin panel in account settings of an admin user.

Throws an error if stripe is not configured.

Double checks with database once per minute to see if the keys have changed,
and if so will return new stripe object.
*/

import Stripe from "stripe";
import { getServerSettings } from "@cocalc/database/settings";
import {
  beginStripeMutation,
  finishStripeMutation,
  isStripeMutationAuthorityEnforcementEnabled,
} from "@cocalc/server/purchases/billing-authority/context";

// See https://stripe.com/docs/api/versioning
const apiVersion = "2026-04-22.dahlia";

type StripeWithPublishableKey = InstanceType<typeof Stripe> & {
  publishable_key: string;
};

let stripe: StripeWithPublishableKey | undefined = undefined;
let key: string = "";
let last: number = 0;

type StripeHttpClient = ReturnType<typeof Stripe.createNodeHttpClient>;

function stripeResponseRequestsRetry(
  response: Awaited<ReturnType<StripeHttpClient["makeRequest"]>>,
): boolean {
  const retryHeader = Object.entries(response.getHeaders?.() ?? {}).find(
    ([name]) => name.toLowerCase() === "stripe-should-retry",
  )?.[1];
  return (Array.isArray(retryHeader) ? retryHeader : [retryHeader]).some(
    (value) =>
      typeof value === "string" && value.trim().toLowerCase() === "true",
  );
}

export function createAuthorityGuardedStripeHttpClient(
  delegate: StripeHttpClient,
): StripeHttpClient {
  return {
    getClientName: () => `BillingAuthority(${delegate.getClientName()})`,
    makeRequest: async (
      ...args: Parameters<StripeHttpClient["makeRequest"]>
    ) => {
      const [, , path, method] = args;
      if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) {
        // Default-off rollout must be indistinguishable from the legacy Stripe
        // transport, including preserving any caller-provided idempotency key.
        if (!isStripeMutationAuthorityEnforcementEnabled()) {
          return await delegate.makeRequest(...args);
        }
        const headers = (args[4] ?? {}) as Exclude<(typeof args)[4], undefined>;
        args[4] = headers;
        const existingHeader = Object.keys(headers).find(
          (name) => name.toLowerCase() === "idempotency-key",
        );
        const key = await beginStripeMutation({
          method,
          path,
          body: `${args[5] ?? ""}`,
          existing_key: existingHeader
            ? `${headers[existingHeader] ?? ""}`
            : undefined,
        });
        if (existingHeader && existingHeader !== "Idempotency-Key") {
          delete headers[existingHeader];
        }
        headers["Idempotency-Key"] = key;
        try {
          const response = await delegate.makeRequest(...args);
          finishStripeMutation({
            key,
            status: response.getStatusCode?.(),
            retry_requested: stripeResponseRequestsRetry(response),
          });
          return response;
        } catch (err) {
          finishStripeMutation({ key, ambiguous: true });
          throw err;
        }
      }
      return await delegate.makeRequest(...args);
    },
  } as StripeHttpClient;
}

export async function getConn(): Promise<StripeWithPublishableKey> {
  if (stripe != null && Date.now() - last <= 1000 * 60) {
    return stripe;
  }
  const { stripe_publishable_key, stripe_secret_key } =
    await getServerSettings();
  if (!stripe_publishable_key) {
    throw Error(
      "stripe publishable key is not set -- billing functionality not available",
    );
  }
  if (!stripe_secret_key) {
    throw Error(
      "stripe secret key is not set -- billing functionality not available",
    );
  }
  if (stripe == null || key != stripe_publishable_key + stripe_secret_key) {
    key = stripe_publishable_key + stripe_secret_key;
    stripe = new Stripe(stripe_secret_key, {
      apiVersion,
      httpClient: createAuthorityGuardedStripeHttpClient(
        Stripe.createNodeHttpClient(),
      ),
    }) as StripeWithPublishableKey;
    stripe.publishable_key = stripe_publishable_key;
    last = Date.now();
  }
  return stripe;
}

export default getConn;
