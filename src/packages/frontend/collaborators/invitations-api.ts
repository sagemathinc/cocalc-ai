/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { PeopleInvitationsApi } from "@cocalc/util/people-invitations";
import type { InvitationDiscoveryApi } from "./invitation-api";
import type { PeopleInvitationDiscoveryApi } from "@cocalc/util/people-invitation-discovery";
import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";

/** Bind a workflow to its original account and connection, including late replies. */
export function boundInvitationsApi(
  accountId: string,
): PeopleInvitationsApi & InvitationDiscoveryApi {
  const client = webapp_client.conat_client;
  function service() {
    if (
      !accountId ||
      redux.getStore("account")?.get("account_id") !== accountId ||
      webapp_client.conat_client !== client
    )
      throw Error(
        "Your session changed. Reopen invitations in the current account.",
      );
    return client.hub.collaborators;
  }
  async function call<T>(
    operation: (
      api: PeopleInvitationsApi & PeopleInvitationDiscoveryApi,
    ) => Promise<T>,
  ) {
    const result = await operation(service());
    service();
    return result;
  }
  return {
    resolveRecipient: (input) =>
      call((api) =>
        api.resolveInvitationRecipient({ ...input, account_id: accountId }),
      ),
    listProjects: (input) =>
      call((api) =>
        api.listInvitationProjects({ ...input, account_id: accountId }),
      ),
    prepareInvitation: (input) =>
      call((api) => api.prepareInvitation({ ...input, account_id: accountId })),
    reviewInvitation: (input) =>
      call((api) => api.reviewInvitation({ ...input, account_id: accountId })),
    sendInvitation: (input) =>
      call((api) => api.sendInvitation({ ...input, account_id: accountId })),
    getInvitationOperation: (input) =>
      call((api) =>
        api.getInvitationOperation({ ...input, account_id: accountId }),
      ),
  };
}
