/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getServerSettings } from "@cocalc/database/settings/server-settings";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import { to_bool } from "@cocalc/util/db-schema/site-defaults";

type SettingsRecord = Record<string, any>;

export const LAUNCH_KILL_SWITCHES = {
  readMostlyMaintenance: "launch_read_mostly_maintenance",
  disableProjectCreation: "launch_disable_project_creation",
  disableFreeProjectStarts: "launch_disable_free_project_starts",
  disableUserHostCreate: "launch_disable_user_host_create",
  disableAi: "launch_disable_ai",
  disablePaymentCheckout: "launch_disable_payment_checkout",
} as const;

async function getLaunchFlag(
  key: (typeof LAUNCH_KILL_SWITCHES)[keyof typeof LAUNCH_KILL_SWITCHES],
): Promise<boolean> {
  const settings = (await getServerSettings()) as SettingsRecord;
  return to_bool(settings[key]);
}

async function isAdminAccount(account_id?: string): Promise<boolean> {
  if (!account_id) return false;
  return await isAdmin(account_id);
}

export async function isReadMostlyMaintenanceEnabled(): Promise<boolean> {
  return await getLaunchFlag(LAUNCH_KILL_SWITCHES.readMostlyMaintenance);
}

async function assertReadMostlyMaintenanceAllowed({
  account_id,
  action,
  admin_bypass = true,
}: {
  account_id?: string;
  action: string;
  admin_bypass?: boolean;
}): Promise<void> {
  if (!(await isReadMostlyMaintenanceEnabled())) {
    return;
  }
  if (admin_bypass && (await isAdminAccount(account_id))) {
    return;
  }
  throw new Error(
    `${action} is temporarily disabled because the site is in read-mostly maintenance mode.`,
  );
}

export async function assertProjectCreationAllowed({
  account_id,
}: {
  account_id?: string;
}): Promise<void> {
  await assertReadMostlyMaintenanceAllowed({
    account_id,
    action: "Creating new projects",
  });
  if (!(await getLaunchFlag(LAUNCH_KILL_SWITCHES.disableProjectCreation))) {
    return;
  }
  if (await isAdminAccount(account_id)) {
    return;
  }
  throw new Error(
    "Creating new projects is temporarily disabled by the site administrator.",
  );
}

export async function assertUserHostCreateAllowed({
  account_id,
}: {
  account_id?: string;
}): Promise<void> {
  await assertReadMostlyMaintenanceAllowed({
    account_id,
    action: "Creating new dedicated hosts",
  });
  if (!(await getLaunchFlag(LAUNCH_KILL_SWITCHES.disableUserHostCreate))) {
    return;
  }
  if (await isAdminAccount(account_id)) {
    return;
  }
  throw new Error(
    "Creating new dedicated hosts is temporarily disabled by the site administrator.",
  );
}

export async function assertFreeProjectStartAllowed({
  actor_account_id,
  sponsor_account_id,
}: {
  actor_account_id?: string;
  sponsor_account_id: string;
}): Promise<void> {
  await assertReadMostlyMaintenanceAllowed({
    account_id: actor_account_id,
    action: "Starting projects",
  });
  if (!(await getLaunchFlag(LAUNCH_KILL_SWITCHES.disableFreeProjectStarts))) {
    return;
  }
  if (await isAdminAccount(actor_account_id)) {
    return;
  }
  const membership = await resolveMembershipForAccount(sponsor_account_id);
  if (membership.source !== "free") {
    return;
  }
  throw new Error(
    "Starting free projects is temporarily disabled by the site administrator. Paid and admin-sponsored project starts are still allowed.",
  );
}

export async function isAiLaunchDisabled(): Promise<boolean> {
  return (
    (await isReadMostlyMaintenanceEnabled()) ||
    (await getLaunchFlag(LAUNCH_KILL_SWITCHES.disableAi))
  );
}

export async function assertAiLaunchAllowed(): Promise<void> {
  await assertReadMostlyMaintenanceAllowed({
    action: "AI and Codex",
    admin_bypass: false,
  });
  if (!(await isAiLaunchDisabled())) {
    return;
  }
  throw new Error(
    "AI and Codex are temporarily disabled by the site administrator.",
  );
}

export async function assertPaymentCheckoutAllowed(): Promise<void> {
  await assertReadMostlyMaintenanceAllowed({
    action: "Payment checkout",
    admin_bypass: false,
  });
  if (!(await getLaunchFlag(LAUNCH_KILL_SWITCHES.disablePaymentCheckout))) {
    return;
  }
  throw new Error(
    "Payment checkout is temporarily disabled by the site administrator.",
  );
}
