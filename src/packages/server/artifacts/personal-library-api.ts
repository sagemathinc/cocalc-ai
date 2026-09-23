/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { PersonalLibraryApi } from "@cocalc/conat/hub/api/personal-library";
import { createHash } from "node:crypto";
import { createInterBayPersonalLibraryClient } from "@cocalc/conat/inter-bay/personal-library";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { getEntry } from "@cocalc/server/artifacts/catalog-api";
import { artifactCatalogKey } from "@cocalc/util/artifact-catalog";
import {
  parsePersonalLibraryPinKey,
  validatePersonalLibraryPinKey,
} from "@cocalc/util/personal-library";
import { personalLibraryStore } from "./personal-library-store";

async function home(accountId: string): Promise<PersonalLibraryApi> {
  requireUuid(accountId, "account_id");
  const { home_bay_id } = await resolveAccountHomeBay({
    account_id: accountId,
  });
  if (!home_bay_id) throw Error("Account home unavailable");
  return home_bay_id === getConfiguredBayId()
    ? personalLibraryStore
    : createInterBayPersonalLibraryClient(
        getInterBayFabricClient(),
        home_bay_id,
      );
}

export const personalLibraryApi: PersonalLibraryApi = {
  async list(opts) {
    return (await home(opts.account_id!)).list(opts);
  },
  async resolve(opts) {
    return (await home(opts.account_id!)).resolve(opts);
  },
  async setPinned(opts) {
    if (opts.pinned) {
      const locator = parsePersonalLibraryPinKey(
        validatePersonalLibraryPinKey(opts.pin_key),
      );
      const entry = await getEntry({
        account_id: opts.account_id,
        project_id: locator.project_id,
        entry_id: createHash("sha256")
          .update(artifactCatalogKey(locator, locator))
          .digest("hex"),
      });
      if (
        !entry ||
        entry.chat_path !== locator.chat_path ||
        entry.item.thread_id !== locator.thread_id ||
        entry.item.artifact_id !== locator.artifact_id
      )
        throw Error("Artifact unavailable");
    }
    return (await home(opts.account_id!)).setPinned(opts);
  },
  async movePinned(opts) {
    return (await home(opts.account_id!)).movePinned(opts);
  },
  async name(opts) {
    const entry = await getEntry({
      account_id: opts.account_id,
      project_id: opts.project_id,
      entry_id: opts.entry_id,
    });
    if (!entry) throw Error("Artifact unavailable");
    return (await home(opts.account_id!)).name(opts);
  },
};

/** Trusted inter-bay entrypoint; never re-route a request arriving at a stale home. */
export const personalLibraryHomeControl: PersonalLibraryApi = {
  async list(opts) {
    return checked(opts.account_id!, (api) => api.list(opts));
  },
  async resolve(opts) {
    return checked(opts.account_id!, (api) => api.resolve(opts));
  },
  async name(opts) {
    return checked(opts.account_id!, (api) => api.name(opts));
  },
  async setPinned(opts) {
    return checked(opts.account_id!, (api) => api.setPinned(opts));
  },
  async movePinned(opts) {
    return checked(opts.account_id!, (api) => api.movePinned(opts));
  },
};

async function checked<T>(
  accountId: string,
  run: (api: PersonalLibraryApi) => Promise<T>,
): Promise<T> {
  requireUuid(accountId, "account_id");
  const { home_bay_id } = await resolveAccountHomeBay({
    account_id: accountId,
  });
  if (home_bay_id !== getConfiguredBayId())
    throw Error("Stale account-home route");
  return run(personalLibraryStore);
}
