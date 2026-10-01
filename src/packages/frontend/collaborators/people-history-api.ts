/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { CollaboratorsApi } from "@cocalc/conat/hub/api/collaborators";
import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { InvitationHistoryApi } from "./invitation-history";
import { notifyCollabInvitesChanged } from "./invite-events";
import { uuid } from "@cocalc/util/misc";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";
import { collaboratorsTargetPath } from "./routing";

export type PeopleHistoryApi = InvitationHistoryApi &
  Pick<CollaboratorsApi, "listPeopleContacts" | "getPeopleContact">;

export function boundPeopleHistoryApi(accountId: string): PeopleHistoryApi {
  const client = webapp_client.conat_client;
  const resendOperations = new Map<string, string>();
  function check() {
    if (
      !accountId ||
      redux.getStore("account")?.get("account_id") !== accountId ||
      client !== webapp_client.conat_client
    )
      throw Error(
        "Your session changed. Reopen invitations in the current account.",
      );
  }
  async function call<T>(operation: () => Promise<T>): Promise<T> {
    check();
    const result = await operation();
    check();
    return result;
  }
  return {
    listPeopleContacts: (input) =>
      call(() =>
        client.hub.collaborators.listPeopleContacts({
          ...input,
          account_id: accountId,
        }),
      ),
    getPeopleContact: (input) =>
      call(() =>
        client.hub.collaborators.getPeopleContact({
          ...input,
          account_id: accountId,
        }),
      ),
    listInvitationHistory: (input) =>
      call(() =>
        client.hub.collaborators.listInvitationHistory({
          ...input,
          account_id: accountId,
        }),
      ),
    manage: async (row, action) => {
      check();
      if (row.kind === "collaboration") {
        const notificationId = row.delivery.find(
          (receipt) => receipt.channel === "notification",
        )?.receipt_id;
        if (
          action !== "dismiss" ||
          row.recipient_account_id !== accountId ||
          !notificationId
        )
          throw Error("This invitation action is not available.");
        await call(() =>
          client.hub.notifications.archive({
            account_id: accountId,
            notification_ids: [notificationId],
            archived: true,
          }),
        );
        notifyCollabInvitesChanged(row.project_id);
        return;
      }
      if (action === "resend") {
        const key = `${row.project_id}:${row.invitation_id}`;
        const operation_id = resendOperations.get(key) ?? uuid();
        resendOperations.set(key, operation_id);
        const result = await call(() =>
          client.hub.projects.resendCollabInvite({
            project_id: row.project_id,
            invite_id: row.invitation_id,
            operation_id,
          }),
        );
        if (result.status !== "unknown") resendOperations.delete(key);
        notifyCollabInvitesChanged(row.project_id);
        return result.status === "sent"
          ? "Invitation email submitted. This does not confirm receipt."
          : result.status === "unknown"
            ? "Email delivery outcome is unknown. Repeating this action will inspect the same operation, not submit another email."
            : `No email was sent${result.reason ? `: ${result.reason}` : ""}.`;
      } else if (action === "copy") {
        if (!["email", "course_email"].includes(row.invite_source)) {
          if (!row.recipient_account_id || row.status !== "pending")
            throw Error("This invitation link is not available.");
          // This is a navigation link, not a bearer token. The recipient must
          // sign in; the existing read/respond APIs still enforce their identity.
          const path = joinUrlPath(
            appBasePath,
            collaboratorsTargetPath({
              view: "invites",
              invitationId: row.invitation_id,
            }),
          );
          await navigator.clipboard.writeText(
            new URL(path, window.location.origin).href,
          );
          check();
          return "Invitation link copied. The recipient must sign in to the invited account to accept.";
        }
        const result = await call(() =>
          client.hub.projects.copyEmailProjectInviteLink({
            account_id: accountId,
            project_id: row.project_id,
            invite_id: row.invitation_id,
            invite_base_url: window.location.origin,
          }),
        );
        check();
        await navigator.clipboard.writeText(result.invite_url);
      } else if (
        action === "accept" ||
        action === "decline" ||
        action === "revoke"
      ) {
        await call(() =>
          client.hub.projects.respondCollabInvite({
            account_id: accountId,
            project_id: row.project_id,
            invite_id: row.invitation_id,
            action,
          }),
        );
        notifyCollabInvitesChanged(row.project_id);
      } else throw Error("This invitation action is not available.");
    },
  };
}
