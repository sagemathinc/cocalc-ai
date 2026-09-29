/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import { getSecretSettingsKey } from "@cocalc/database/settings/secret-settings";
import {
  encryptSecretSettingValue,
  decryptSecretSettingValue,
} from "@cocalc/util/secret-settings-crypto";
import type {
  PeopleInvitationOperation,
  PeopleInvitationDeliveryReceipt,
} from "@cocalc/util/people-invitations";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { peopleHome } from "@cocalc/server/people/common";
import {
  getPeopleContact,
  ensurePeopleContact,
} from "@cocalc/server/people/api";
import { queueContentInvitationNotification } from "@cocalc/server/notifications/content-invitation";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import {
  preflightPeopleInvitationAction,
  inspectPeopleInvitationAccess,
  executePeopleInvitationAccess,
} from "@cocalc/server/people/invitation-actions";
import { recordPeopleInvitationOperation } from "@cocalc/server/people/collaboration-projections";
import { PeopleInvitationStore } from "./invitations-store";
import {
  PeopleInvitationService,
  invitationReviewRequired,
} from "./invitations";
import type { PeopleInvitationServices } from "./invitations";
import { refreshPeopleInvitationDelivery } from "./invitations-delivery";
import { peopleCollaborationInvitationId } from "./invitations-identity";

const aad = "people-invitations:v1";
const successful = (operation: PeopleInvitationOperation) =>
  operation.outcomes.filter((r) =>
    ["created", "reused", "notified"].includes(r.status),
  );

const services: PeopleInvitationServices = {
  refreshDelivery: refreshPeopleInvitationDelivery,
  async authorizeHome(account_id) {
    if (
      process.env.COCALC_PRODUCT === "lite" ||
      !(await getServerSettings()).collaborators_enabled
    )
      throw Error("People invitations are unavailable on this server");
    if ((await peopleHome(account_id)) !== getConfiguredBayId())
      throw Error("stale invitation account-home route");
  },
  async preflight(account_id, payload, action) {
    const recipient = payload.recipient;
    if (recipient.person_id) {
      const contact = await getPeopleContact({
        account_id,
        person_id: recipient.person_id,
      });
      if (
        !contact ||
        (recipient.kind === "account"
          ? contact.linked_account_id !== recipient.account_id
          : contact.email !== recipient.email_address)
      )
        throw invitationReviewRequired();
    }
    return preflightPeopleInvitationAction(account_id, payload, action);
  },
  inspectAccess: inspectPeopleInvitationAccess,
  executeAccess: executePeopleInvitationAccess,
  async prepareDelivery(operation) {
    if (Date.now() >= operation.authorization_expires_at)
      throw invitationReviewRequired();
    const outcomes = successful(operation);
    for (const outcome of outcomes) {
      const action = operation.payload.projects.find(
        (a) => a.project_id === outcome.project_id,
      )!;
      const check = await services.preflight(
        operation.account_id,
        operation.payload,
        action,
      );
      if (action.action === "notify" && check.recipient_access !== "sufficient")
        throw invitationReviewRequired();
    }
    const recipient = operation.payload.recipient;
    const recipient_home_bay_id =
      recipient.kind === "account"
        ? (await getClusterAccountById(recipient.account_id))?.home_bay_id
        : undefined;
    if (recipient.kind === "account" && !recipient_home_bay_id)
      throw Error("invitation recipient home unavailable");
    return async (db, current) => {
      if (Date.now() >= current.authorization_expires_at)
        throw invitationReviewRequired();
      if (!outcomes.length) return;
      const access_invite_ids = outcomes.flatMap((r) =>
        r.access_invite_id ? [r.access_invite_id] : [],
      );
      const delivery: PeopleInvitationDeliveryReceipt[] = [];
      if (recipient.kind === "account") {
        const result = await queueContentInvitationNotification({
          db,
          operation_id: current.operation_id,
          invitation_id: peopleCollaborationInvitationId(
            current.operation_id,
            outcomes[0].child_operation_id,
          ),
          sender_account_id: current.account_id,
          recipient_account_id: recipient.account_id,
          recipient_home_bay_id: recipient_home_bay_id!,
          project_id:
            current.payload.target?.project_id ?? outcomes[0].project_id,
          authored_label: current.payload.target?.label,
          message: current.payload.message,
          access_invite_ids,
          channels: current.payload.channels,
        });
        for (const channel of ["notification", "email"] as const) {
          delivery.push({
            channel,
            status:
              current.payload.channels[channel] &&
              result.status !== "suppressed"
                ? "queued"
                : "suppressed",
            ...(result.status === "suppressed" ||
            !current.payload.channels[channel]
              ? {}
              : { receipt_id: result.notification_id }),
          });
        }
      } else {
        delivery.push({
          channel: "notification",
          status: "suppressed",
          reason: "email_only_recipient",
        });
      }
      for (const outcome of successful(current)) {
        outcome.collaboration_invitation_id = peopleCollaborationInvitationId(
          current.operation_id,
          outcome.child_operation_id,
        );
        outcome.delivery = [
          ...outcome.delivery.filter(
            (d) => !delivery.some((v) => v.channel === d.channel),
          ),
          ...delivery,
        ];
      }
    };
  },
  async projectOutcome(operation) {
    if (
      !successful(operation).some(
        (r) =>
          r.access_invite_id ||
          (r.collaboration_invitation_id && r.delivery.length),
      )
    )
      return;
    const recipient = operation.payload.recipient;
    await ensurePeopleContact({
      account_id: operation.account_id,
      recipient:
        recipient.kind === "account"
          ? { account_id: recipient.account_id }
          : { email: recipient.email_address },
    });
    await recordPeopleInvitationOperation({
      ...operation,
      outcomes: operation.outcomes.filter(
        (r) => r.collaboration_invitation_id && r.delivery.length,
      ),
    });
  },
};

let service: PeopleInvitationService | undefined;
export function getPeopleInvitationService(): PeopleInvitationService {
  if (!service) {
    const store = new PeopleInvitationStore(getPool(), {
      async seal(value) {
        return encryptSecretSettingValue(
          aad,
          JSON.stringify(value),
          await getSecretSettingsKey(),
        );
      },
      async open<T>(value: string): Promise<T> {
        return JSON.parse(
          decryptSecretSettingValue(aad, value, await getSecretSettingsKey()),
        );
      },
    });
    service = new PeopleInvitationService(store, services);
  }
  return service;
}

let running = false;
export async function runPeopleInvitationMaintenance() {
  if (running) return;
  if (
    process.env.COCALC_PRODUCT === "lite" ||
    !(await getServerSettings()).collaborators_enabled
  )
    return;
  running = true;
  try {
    await getPeopleInvitationService().maintenance();
  } finally {
    running = false;
  }
}
