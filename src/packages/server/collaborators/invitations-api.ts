/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { CollaboratorsApi } from "@cocalc/conat/hub/api/collaborators";
import type {
  InterBayCollaboratorsApi,
  CollaborationRoute,
} from "@cocalc/conat/inter-bay/collaborators";
import { createInterBayCollaboratorsClient } from "@cocalc/conat/inter-bay/collaborators";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { peopleInvitationUuid } from "@cocalc/util/people-invitations";
import * as history from "@cocalc/server/people/api";
import { peopleHome } from "@cocalc/server/people/common";
import { getPeopleInvitationService } from "./invitations-runtime";
import { getCurrentAuthSessionForSessionHash } from "@cocalc/server/auth/auth-sessions";
import { readContentInvitationDeliveryOnHomeBay } from "@cocalc/server/notifications/content-invitation-delivery";
import {
  resolveInvitationRecipientLocal,
  listInvitationProjectsLocal,
  inspectInvitationProject,
} from "./invitations-discovery";

type Methods =
  | "resolveInvitationRecipient"
  | "listInvitationProjects"
  | "prepareInvitation"
  | "reviewInvitation"
  | "sendInvitation"
  | "getInvitationOperation"
  | "listPeopleContacts"
  | "getPeopleContact"
  | "listInvitationHistory"
  | "getInvitationCounts";
type Api = Pick<CollaboratorsApi, Methods>;
type Control = Pick<
  InterBayCollaboratorsApi,
  Methods | "inspectInvitationProject" | "readInvitationDelivery"
>;

async function enabled() {
  if (
    process.env.COCALC_PRODUCT === "lite" ||
    !(await getServerSettings()).collaborators_enabled
  )
    throw Error("People invitations are unavailable on this server");
}
async function home<T>(
  account_id: string | undefined,
  invoke: (
    api: InterBayCollaboratorsApi,
    route: CollaborationRoute,
  ) => Promise<T>,
) {
  await enabled();
  const id = peopleInvitationUuid(account_id, "authenticated account_id");
  const { home_bay_id } = await resolveAccountHomeBay({ account_id: id });
  if (!home_bay_id) throw Error("invitation account home unavailable");
  const api =
    home_bay_id === getConfiguredBayId()
      ? (await import("./api")).collaboratorsControl
      : createInterBayCollaboratorsClient({
          client: getInterBayFabricClient(),
          bay_id: home_bay_id,
        });
  return invoke(api, { bay_id: home_bay_id });
}
async function local(opts: { account_id?: string; route: CollaborationRoute }) {
  await enabled();
  const account_id = peopleInvitationUuid(
    opts.account_id,
    "authenticated account_id",
  );
  if (
    opts.route?.bay_id !== getConfiguredBayId() ||
    (await peopleHome(account_id)) !== getConfiguredBayId()
  )
    throw Error("stale invitation account-home route");
  return account_id;
}
function session(opts: unknown): string {
  // Injected by the bound-session auth transform, not part of the public contract.
  const value = (opts as { session_hash?: string }).session_hash;
  if (typeof value !== "string" || !value)
    throw Error("human session required");
  return value;
}

async function human(opts: { account_id?: string; route: CollaborationRoute }) {
  const account_id = await local(opts);
  await getCurrentAuthSessionForSessionHash({
    account_id,
    session_hash: session(opts),
  });
  return account_id;
}

export const invitationPublicApi: Api = {
  resolveInvitationRecipient: (opts) =>
    home(opts.account_id, (api, route) =>
      api.resolveInvitationRecipient({ ...opts, route }),
    ),
  listInvitationProjects: (opts) =>
    home(opts.account_id, (api, route) =>
      api.listInvitationProjects({ ...opts, route }),
    ),
  prepareInvitation: (opts) =>
    home(opts.account_id, (api, route) =>
      api.prepareInvitation({ ...opts, route }),
    ),
  reviewInvitation: (opts) =>
    home(opts.account_id, (api, route) =>
      api.reviewInvitation({ ...opts, route }),
    ),
  sendInvitation: (opts) =>
    home(opts.account_id, (api, route) =>
      api.sendInvitation({ ...opts, route }),
    ),
  getInvitationOperation: (opts) =>
    home(opts.account_id, (api, route) =>
      api.getInvitationOperation({ ...opts, route }),
    ),
  listPeopleContacts: (opts) =>
    home(opts.account_id, (api, route) =>
      api.listPeopleContacts({ ...opts, route }),
    ),
  getPeopleContact: (opts) =>
    home(opts.account_id, (api, route) =>
      api.getPeopleContact({ ...opts, route }),
    ),
  listInvitationHistory: (opts) =>
    home(opts.account_id, (api, route) =>
      api.listInvitationHistory({ ...opts, route }),
    ),
  getInvitationCounts: (opts) =>
    home(opts.account_id, (api, route) =>
      api.getInvitationCounts({ ...opts, route }),
    ),
};

export const invitationControlApi: Control = {
  async readInvitationDelivery(opts) {
    await local({ account_id: opts.recipient_account_id, route: opts.route });
    return readContentInvitationDeliveryOnHomeBay(opts);
  },
  inspectInvitationProject,
  async resolveInvitationRecipient(opts) {
    return resolveInvitationRecipientLocal({
      ...opts,
      account_id: await local(opts),
    });
  },
  async listInvitationProjects(opts) {
    return listInvitationProjectsLocal({
      ...opts,
      account_id: await local(opts),
    });
  },
  async prepareInvitation(opts) {
    return getPeopleInvitationService().prepare(
      await human(opts),
      opts,
      session(opts),
    );
  },
  async reviewInvitation(opts) {
    return getPeopleInvitationService().review(
      await human(opts),
      opts,
      session(opts),
    );
  },
  async sendInvitation(opts) {
    return getPeopleInvitationService().send(
      await human(opts),
      opts,
      session(opts),
    );
  },
  async getInvitationOperation(opts) {
    return getPeopleInvitationService().status(
      await human(opts),
      opts.operation_id,
      session(opts),
    );
  },
  async listPeopleContacts(opts) {
    return history.listPeopleContacts({
      ...opts,
      account_id: await local(opts),
    });
  },
  async getPeopleContact(opts) {
    return history.getPeopleContact({ ...opts, account_id: await local(opts) });
  },
  async listInvitationHistory(opts) {
    return history.listInvitationHistory({
      ...opts,
      account_id: await local(opts),
    });
  },
  async getInvitationCounts(opts) {
    return history.getPeopleInvitationCounts({
      ...opts,
      account_id: await local(opts),
    });
  },
};
