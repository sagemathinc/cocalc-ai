/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { CollaboratorsApi } from "@cocalc/conat/hub/api/collaborators";
import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { refreshNamedAgentsForAccount } from "@cocalc/frontend/agents/api";
import { refreshPersonalLibrary } from "@cocalc/frontend/agents/personal-library";

export type DirectoryApi = Pick<
  CollaboratorsApi,
  | "listPeople"
  | "resolveChatAlias"
  | "resolvePersonAlias"
  | "getPersonAlias"
  | "setPersonAlias"
  | "listProjects"
  | "setProjectPinned"
  | "listResources"
  | "listProjectResources"
  | "getResource"
  | "setPersonalState"
  | "ensureRoom"
  | "getRoom"
  | "check"
>;

export function boundCollaboratorsApi(accountId: string): DirectoryApi {
  const client = webapp_client.conat_client;
  function api() {
    if (
      !accountId ||
      redux.getStore("account")?.get("account_id") !== accountId ||
      webapp_client.conat_client !== client
    )
      throw Error(
        "Your session changed. Reopen People in the current account.",
      );
    return client.hub.collaborators;
  }
  async function call<T>(
    operation: (service: CollaboratorsApi) => Promise<T>,
  ): Promise<T> {
    const value = await operation(api());
    api(); // Reject late responses from a previous account or server.
    return value;
  }
  return {
    resolveChatAlias: (opts) =>
      call((service) =>
        service.resolveChatAlias({ ...opts, account_id: accountId }),
      ),
    resolvePersonAlias: (opts) =>
      call((service) =>
        service.resolvePersonAlias({ ...opts, account_id: accountId }),
      ),
    getPersonAlias: (opts) =>
      call((service) =>
        service.getPersonAlias({ ...opts, account_id: accountId }),
      ),
    setPersonAlias: (opts) =>
      call((service) =>
        service.setPersonAlias({ ...opts, account_id: accountId }),
      ),
    check: (opts) =>
      call((service) => service.check({ ...opts, account_id: accountId })),
    listPeople: (opts) =>
      call((service) => service.listPeople({ ...opts, account_id: accountId })),
    listProjects: (opts) =>
      call((service) =>
        service.listProjects({ ...opts, account_id: accountId }),
      ),
    setProjectPinned: (opts) =>
      call((service) =>
        service.setProjectPinned({ ...opts, account_id: accountId }),
      ),
    listResources: (opts) =>
      call((service) =>
        service.listResources({ ...opts, account_id: accountId }),
      ),
    listProjectResources: (opts) =>
      call((service) =>
        service.listProjectResources({ ...opts, account_id: accountId }),
      ),
    getResource: (opts) =>
      call((service) =>
        service.getResource({ ...opts, account_id: accountId }),
      ),
    setPersonalState: async (opts) => {
      const state = await call((service) =>
        service.setPersonalState({ ...opts, account_id: accountId }),
      );
      // Attention-only writes never change personal names or collection shortcuts.
      if (
        opts.patch.alias !== undefined ||
        opts.patch.collected !== undefined
      ) {
        if (opts.kind === "agent") refreshNamedAgentsForAccount(accountId);
        else if (opts.kind === "artifact") refreshPersonalLibrary(accountId);
      }
      return state;
    },
    ensureRoom: (opts) =>
      call((service) => service.ensureRoom({ ...opts, account_id: accountId })),
    getRoom: (opts) =>
      call((service) => service.getRoom({ ...opts, account_id: accountId })),
  };
}
