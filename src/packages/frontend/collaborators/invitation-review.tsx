/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type {
  PeopleInvitationOperation,
  PeopleInvitationReview,
} from "@cocalc/util/people-invitations";
import type { InvitationProject } from "./invitation-api";
import { invitationChoiceLabel } from "./invitation-choices";
import { InvitationPolicyDetails } from "./invitation-projects-table";

const preflightWarningLabels: Record<string, string> = {
  compatible_pending_offer:
    "A compatible invitation is already pending. It can be reused without changing its role or read policy.",
  content_requires_collaborator:
    "Opening this content requires collaborator access. A viewer is not upgraded automatically; the recipient must accept the reviewed collaborator offer.",
};

export function InvitationReviewDetails({
  review,
  recipientLabel,
  projects,
}: {
  review: PeopleInvitationReview;
  recipientLabel?: string;
  projects: Record<string, InvitationProject>;
}) {
  const { payload, preflight } = review.draft;
  const identity =
    payload.recipient.kind === "email"
      ? payload.recipient.email_address
      : payload.recipient.account_id;
  return (
    <section
      aria-label="Exact reviewed invitation"
      style={{ overflowWrap: "anywhere" }}
    >
      <h3>Exact recipient and actions</h3>
      <p>
        {recipientLabel} ({payload.recipient.kind}: {identity})
      </p>
      {payload.target && (
        <p>
          Content: {payload.target.label ?? payload.target.kind}; project{" "}
          {payload.target.project_id}; {payload.target.kind} ID{" "}
          <code>{payload.target.resource_id}</code>. Content stays in its source
          project.
        </p>
      )}
      <ul>
        {payload.projects.map((choice) => (
          <li key={choice.project_id}>
            <strong>
              {projects[choice.project_id]?.title ?? choice.project_id}
            </strong>
            : {invitationChoiceLabel(choice)}
            <p>
              Project ID: <code>{choice.project_id}</code>
            </p>
            {choice.action === "offer_access" && choice.role === "viewer" && (
              <InvitationPolicyDetails policy={choice.read_policy} />
            )}
            {preflight
              .filter((check) => check.project_id === choice.project_id)
              .map((check) => (
                <div key={check.project_id}>
                  <p>Current access: {check.recipient_access}</p>
                  {check.warnings.map((warning, index) => (
                    <p key={index}>
                      {preflightWarningLabels[warning] ?? warning}
                    </p>
                  ))}
                </div>
              ))}
          </li>
        ))}
      </ul>
      <p>
        Collaborator access covers the whole project, not just the selected
        content. Viewer access follows the exact read policy shown.
        Notification-only actions never change access.
      </p>
      <p>Message:</p>
      <blockquote style={{ whiteSpace: "pre-wrap" }}>
        {payload.message || "No message"}
      </blockquote>
      <p>
        Requested channels:{" "}
        {[
          payload.channels.notification && "In-app notification",
          payload.channels.email && "Email",
        ]
          .filter(Boolean)
          .join(", ") || "None"}
        . Delivery is reported separately after send.
      </p>
      <p>
        Draft revision {review.draft.revision}. Review expires{" "}
        {new Date(review.expires_at).toLocaleString()}.
      </p>
    </section>
  );
}

const statusLabels = {
  pending: "Invitation pending execution",
  created: "Invitation created",
  reused: "Compatible pending invitation reused",
  notified: "Collaboration invitation created; no access change",
  review_required: "Review required; no automatic access change",
  failed: "Failed",
  unknown: "Outcome unknown; inspect before retrying",
};

export function InvitationResults({
  operation,
  projects,
}: {
  operation: PeopleInvitationOperation;
  projects: Record<string, InvitationProject>;
}) {
  return (
    <section
      aria-label="Durable invitation outcomes"
      aria-live="polite"
      style={{ overflowWrap: "anywhere" }}
    >
      <p>
        Operation <code>{operation.operation_id}</code>: {operation.status}
      </p>
      <ul>
        {operation.outcomes.map((outcome) => (
          <li key={outcome.child_operation_id}>
            <strong>
              {projects[outcome.project_id]?.title ?? outcome.project_id}:{" "}
              {statusLabels[outcome.status]}
            </strong>
            {outcome.delivery.map((delivery, index) => (
              <p key={`${delivery.channel}:${index}`}>
                {delivery.channel === "email"
                  ? delivery.status === "sent"
                    ? "Email sent"
                    : delivery.status === "queued"
                      ? "Email queued, not yet sent"
                      : delivery.status === "suppressed"
                        ? "No email sent"
                        : delivery.status === "failed"
                          ? "Email failed"
                          : "Email delivery unknown"
                  : delivery.status === "queued"
                    ? "Notification queued"
                    : delivery.status === "sent"
                      ? "Notification sent"
                      : delivery.status === "suppressed"
                        ? "No notification sent"
                        : delivery.status === "failed"
                          ? "Notification failed"
                          : "Notification delivery unknown"}
                {delivery.reason ? `: ${delivery.reason}` : ""}
              </p>
            ))}
            {!outcome.delivery.some(
              (delivery) => delivery.channel === "email",
            ) && (
              <p>
                {operation.payload.channels.email
                  ? "Email delivery not yet reported"
                  : "No email requested"}
              </p>
            )}
            {!outcome.delivery.some(
              (delivery) => delivery.channel === "notification",
            ) && (
              <p>
                {operation.payload.channels.notification
                  ? "Notification delivery not yet reported"
                  : "No notification requested"}
              </p>
            )}
            {outcome.reason && <p>{outcome.reason}</p>}
          </li>
        ))}
      </ul>
      <p>
        Successful actions are retained. Checking status never sends another
        invitation.
      </p>
    </section>
  );
}
