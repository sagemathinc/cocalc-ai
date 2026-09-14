import { getServerSettings } from "@cocalc/database/settings/server-settings";
import getLogger from "@cocalc/backend/logger";
import { hasStripeBillingConfiguration } from "@cocalc/util/stripe/billing";
import maintainMembershipAnalytics from "./maintain-membership-analytics";
import maintainComputeRevenueAnalyticsProjection from "./maintain-compute-revenue-analytics";
import { executeBillingAuthorityCommand } from "./billing-authority/client";
import type { BillingAuthorityMaintenanceTask } from "./billing-authority/protocol";

const logger = getLogger("purchases:maintenance");

// By default wait this long after running maintenance task.
const DEFAULT_DELAY_MS = 1000 * 60 * 5;
const INITIAL_DELAY_MS = 1000 * 10;

let started = false;

interface MaintenanceDescription {
  // The async function to run
  f: () => Promise<void>;
  // A description of what it does (for logging)
  desc: string;
  // Whether Stripe must be configured for this task to make sense.
  requiresStripe?: boolean;
}

const FUNCTIONS: MaintenanceDescription[] = [
  {
    f: authorityMaintenance("subscriptions"),
    desc: "maintain subscriptions",
    requiresStripe: true,
  },
  {
    f: authorityMaintenance("team-licenses"),
    desc: "maintain team licenses",
    requiresStripe: true,
  },
  {
    f: authorityMaintenance("statements"),
    desc: "maintain statements",
  },
  {
    f: authorityMaintenance("payment-intents"),
    desc: "processing any outstanding payment intents",
    requiresStripe: true,
  },
  {
    f: authorityMaintenance("automatic-payments"),
    desc: "maintain automatic payments",
    requiresStripe: true,
  },
  {
    f: authorityMaintenance("auto-balance"),
    desc: "maintain auto balance",
    requiresStripe: true,
  },
  {
    f: maintainMembershipAnalytics,
    desc: "maintain membership analytics",
  },
  {
    f: maintainComputeRevenueAnalyticsProjection,
    desc: "maintain compute revenue analytics",
  },
];

function authorityMaintenance(
  task: BillingAuthorityMaintenanceTask,
): () => Promise<void> {
  return async () => {
    await executeBillingAuthorityCommand({ kind: "maintenance", task });
  };
}

export type MaintenanceSettings = Pick<
  Awaited<ReturnType<typeof getServerSettings>>,
  "stripe_publishable_key" | "stripe_secret_key"
>;

export function getEnabledMaintenanceDescriptions(
  settings: MaintenanceSettings,
): string[] {
  const stripeEnabled = hasStripeBillingConfiguration(settings);
  return FUNCTIONS.filter(
    ({ requiresStripe }) => !requiresStripe || stripeEnabled,
  ).map(({ desc }) => desc);
}

function getEnabledMaintenanceFunctions(
  settings: MaintenanceSettings,
): MaintenanceDescription[] {
  const enabledDescriptions = new Set(
    getEnabledMaintenanceDescriptions(settings),
  );
  return FUNCTIONS.filter(({ desc }) => enabledDescriptions.has(desc));
}

export default function startPurchasesMaintenanceLoop() {
  if (started) {
    return;
  }
  started = true;
  let running: boolean = false;
  async function f() {
    if (running) {
      logger.debug(
        "Skipping round of maintenance since previous one already running",
      );
      return;
    }
    try {
      running = true;
      const settings = await getServerSettings();
      await doMaintenance(getEnabledMaintenanceFunctions(settings));
    } catch (err) {
      logger.error("doMaintenance error", err);
    } finally {
      running = false;
    }
  }
  // Do a first round in a couple of seconds:
  const initial = setTimeout(f, INITIAL_DELAY_MS);
  initial.unref?.();
  // And every few minutes afterwards.
  const interval = setInterval(f, DEFAULT_DELAY_MS);
  interval.unref?.();
  logger.info("purchase maintenance loop started", {
    interval_ms: DEFAULT_DELAY_MS,
    initial_delay_ms: INITIAL_DELAY_MS,
  });
}

async function doMaintenance(functions: MaintenanceDescription[] = FUNCTIONS) {
  logger.debug("doing purchase maintenance");
  for (const { f, desc } of functions) {
    try {
      logger.debug("maintenance ", desc);
      await f();
    } catch (err) {
      logger.error("error running maintenance ", desc, err);
    }
  }
}
