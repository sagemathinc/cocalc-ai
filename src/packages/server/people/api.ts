/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createInterBayPeopleStorageClient } from "@cocalc/conat/inter-bay/people-storage";
import type { InterBayPeopleStorageApi } from "@cocalc/conat/inter-bay/people-storage";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { peopleHome } from "./common";
import { applyCollaborationProjection } from "./collaboration-projections";
export { recordPeopleInvitationOperation } from "./collaboration-projections";
import {
  ensurePeopleContactLocal,
  listPeopleContactsLocal,
  getPeopleContactLocal,
  archivePeopleContactLocal,
} from "./contacts";
import {
  applyAccessProjection,
  listInvitationHistoryLocal,
  getPeopleInvitationCountsLocal,
} from "./invite-projections";

export const peopleStorageControl: InterBayPeopleStorageApi = {
  applyAccessProjection,
  applyCollaborationProjection,
  listInvitationHistory: listInvitationHistoryLocal,
  getPeopleInvitationCounts: getPeopleInvitationCountsLocal,
  listPeopleContacts: listPeopleContactsLocal,
  getPeopleContact: getPeopleContactLocal,
  ensurePeopleContact: ensurePeopleContactLocal,
  archivePeopleContact: archivePeopleContactLocal,
};
export function peopleStorageClient(bay_id: string): InterBayPeopleStorageApi {
  return bay_id === getConfiguredBayId()
    ? peopleStorageControl
    : createInterBayPeopleStorageClient({
        client: getInterBayFabricClient(),
        bay_id,
      });
}
async function home(account_id: string) {
  return peopleStorageClient(await peopleHome(account_id));
}
export const listInvitationHistory: InterBayPeopleStorageApi["listInvitationHistory"] =
  async (opts) => (await home(opts.account_id)).listInvitationHistory(opts);
export const getPeopleInvitationCounts: InterBayPeopleStorageApi["getPeopleInvitationCounts"] =
  async (opts) => (await home(opts.account_id)).getPeopleInvitationCounts(opts);
export const listPeopleContacts: InterBayPeopleStorageApi["listPeopleContacts"] =
  async (opts) => (await home(opts.account_id)).listPeopleContacts(opts);
export const getPeopleContact: InterBayPeopleStorageApi["getPeopleContact"] =
  async (opts) => (await home(opts.account_id)).getPeopleContact(opts);
export const ensurePeopleContact: InterBayPeopleStorageApi["ensurePeopleContact"] =
  async (opts) => (await home(opts.account_id)).ensurePeopleContact(opts);
export const archivePeopleContact: InterBayPeopleStorageApi["archivePeopleContact"] =
  async (opts) => (await home(opts.account_id)).archivePeopleContact(opts);
