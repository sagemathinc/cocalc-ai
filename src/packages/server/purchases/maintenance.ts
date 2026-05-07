import { getServerSettings } from "@cocalc/database/settings/server-settings";
import maintainSubscriptions from "./maintain-subscriptions";
import maintainStatements from "./statements/maintenance";
import getLogger from "@cocalc/backend/logger";
import maintainAutomaticPayments from "./maintain-automatic-payments";
import maintainAutoBalance from "./maintain-auto-balance";
import { maintainPaymentIntents } from "./stripe/process-payment-intents";

const logger = getLogger("purchases:maintenance");

// By default wait this long after running maintenance task.
const DEFAULT_DELAY_MS = 1000 * 60 * 5;

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
];

type MaintenanceSettings = Pick<
  Awaited<ReturnType<typeof getServerSettings>>,
  "stripe_publishable_key" | "stripe_secret_key"
>;

export function hasStripeBillingConfiguration(
  settings: MaintenanceSettings,
): boolean {
  return (
    `${settings.stripe_publishable_key ?? ""}`.trim().length > 0 &&
    `${settings.stripe_secret_key ?? ""}`.trim().length > 0
  );
}

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

export default async function init() {
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
  setTimeout(f, 10000);
  // And every few minutes afterwards.
  setInterval(f, DEFAULT_DELAY_MS);
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
