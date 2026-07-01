import { getServerSettings } from "@cocalc/database/settings/server-settings";
import maintainSubscriptions from "./maintain-subscriptions";
import maintainTeamLicenses from "./maintain-team-licenses";
import maintainStatements from "./statements/maintenance";
import getLogger from "@cocalc/backend/logger";
import maintainAutomaticPayments from "./maintain-automatic-payments";
import maintainAutoBalance from "./maintain-auto-balance";
import { maintainPaymentIntents } from "./stripe/process-payment-intents";
import { hasStripeBillingConfiguration } from "@cocalc/util/stripe/billing";
import maintainMembershipAnalytics from "./maintain-membership-analytics";

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
    f: maintainSubscriptions,
    desc: "maintain subscriptions",
    requiresStripe: true,
  },
  {
    f: maintainTeamLicenses,
    desc: "maintain team licenses",
    requiresStripe: true,
  },
  { f: maintainStatements, desc: "maintain statements" },
  {
    f: maintainPaymentIntents,
    desc: "processing any outstanding payment intents",
    requiresStripe: true,
  },
  {
    f: maintainAutomaticPayments,
    desc: "maintain automatic payments",
    requiresStripe: true,
  },
  {
    f: maintainAutoBalance,
    desc: "maintain auto balance",
    requiresStripe: true,
  },
  {
    f: maintainMembershipAnalytics,
    desc: "maintain membership analytics",
  },
];

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
