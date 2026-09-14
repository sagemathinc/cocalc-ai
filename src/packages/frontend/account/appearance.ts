/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { accountAppearancePreference } from "@cocalc/util/appearance";
import type { AppearancePreference } from "@cocalc/util/appearance";
import { getBrowserAppearanceStore } from "@cocalc/util/appearance-browser";
import type { AppearanceStore } from "@cocalc/util/appearance-store";
import type { AccountActions } from "./actions";
import type { AccountStore } from "./store";

export const ACCOUNT_APPEARANCE_SNAPSHOT = "appearance-snapshot";

export function initAccountAppearance(
  account: Pick<AccountStore, "get" | "on" | "removeListener">,
  actions: Pick<AccountActions, "set_other_settings_and_wait">,
  appearance: AppearanceStore = getBrowserAppearanceStore(),
): () => void {
  let lastAccountId: string | undefined;
  let lastPreference: AppearancePreference | undefined;
  const update = (authoritative = false) => {
    const userType = account.get("user_type");
    if (userType === "public") {
      lastAccountId = undefined;
      lastPreference = undefined;
      appearance.receiveAccount(undefined);
      return;
    }
    // Defaults and a remembered account cookie are not a loaded account snapshot.
    if (!account.get("is_ready") || userType !== "signed_in") return;
    const accountId = account.get("account_id");
    if (!accountId) return;
    const value = account.get("other_settings");
    const settings = value?.toJS?.() ?? value ?? {};
    const preference = accountAppearancePreference(settings);
    // Account changes include unrelated settings. Replaying the same projection
    // can undo a newer choice received from another tab through local storage.
    // Pending saves still need even same-value observations for acknowledgment.
    if (
      !authoritative &&
      accountId === lastAccountId &&
      preference === lastPreference &&
      !appearance.getSnapshot().saving
    ) {
      return;
    }
    lastAccountId = accountId;
    lastPreference = preference;
    appearance.receiveAccount(accountId, preference, async (preference) => {
      if (
        account.get("account_id") !== accountId ||
        account.get("user_type") !== "signed_in"
      ) {
        throw Error("Account changed before appearance could be saved");
      }
      await actions.set_other_settings_and_wait("appearance_theme", preference);
    });
  };
  const onChange = () => update();
  const onSnapshot = (accountId: string) => {
    if (accountId === account.get("account_id")) update(true);
  };
  account.on("change", onChange);
  // Even an equal-valued server observation is authoritative. It must not be
  // confused with an unrelated local change replaying that same stored value.
  account.on(ACCOUNT_APPEARANCE_SNAPSHOT, onSnapshot);
  update();
  return () => {
    account.removeListener("change", onChange);
    account.removeListener(ACCOUNT_APPEARANCE_SNAPSHOT, onSnapshot);
  };
}
