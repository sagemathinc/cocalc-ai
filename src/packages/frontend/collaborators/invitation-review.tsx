/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type {
  PeopleInvitationOperation,
  PeopleInvitationReview,
} from "@cocalc/util/people-invitations";
import { Alert, Avatar, Tag, Typography } from "antd";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { InvitationProject } from "./invitation-api";
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
      <div className="invitation-recipient">
        <Avatar aria-hidden>
          {(recipientLabel ?? identity).slice(0, 1).toUpperCase()}
        </Avatar>
        <strong>
          Invite {recipientLabel ?? identity} to {payload.projects.length}{" "}
          {payload.projects.length === 1 ? "project" : "projects"}
        </strong>
      </div>
      {payload.target && (
        <p>
          Work together on:{" "}
          <strong>{payload.target.label ?? payload.target.kind}</strong>.
          Content stays in its source project.
        </p>
      )}
      <div>
        {payload.projects.map((choice) => (
          <div
            key={choice.project_id}
            className="invitation-summary-row"
            style={{ borderBottom: `1px solid ${UI_COLORS.border}` }}
          >
            <strong>
              {projects[choice.project_id]?.title ?? choice.project_id}
            </strong>
            <Tag>
              {choice.action === "notify"
                ? "Notify only"
                : choice.role === "viewer"
                  ? "Viewer access"
                  : "Collaborator access"}
            </Tag>
            {choice.action === "offer_access" && choice.role === "viewer" && (
              <InvitationPolicyDetails policy={choice.read_policy} />
            )}
            {preflight
              .filter((check) => check.project_id === choice.project_id)
              .map((check) => (
                <div key={check.project_id}>
                  {check.warnings.map((warning, index) => (
                    <p key={index}>
                      {preflightWarningLabels[warning] ?? warning}
                    </p>
                  ))}
                </div>
              ))}
          </div>
        ))}
      </div>
      {payload.projects.some(
        (p) => p.action === "offer_access" && p.role === "collaborator",
      ) && (
        <Alert
          role="note"
          type="info"
          title="After accepting, the recipient can edit files and run code throughout the projects offering collaborator access, not just the selected content."
        />
      )}
      {payload.projects.some(
        (p) => p.action === "offer_access" && p.role === "viewer",
      ) && (
        <Typography.Paragraph>
          Viewer access is read-only, follows the file policies shown, and does
          not allow running code.
        </Typography.Paragraph>
      )}
      {payload.projects.some((p) => p.action === "notify") && (
        <Typography.Paragraph>
          Notification-only actions never change access.
        </Typography.Paragraph>
      )}
      <details className="invitation-help" style={{ marginTop: 12 }}>
        <summary>Technical details</summary>
        <p>
          {payload.recipient.kind}: <code>{identity}</code>
        </p>
        {payload.projects.map((p) => (
          <p key={p.project_id}>
            Project ID: <code>{p.project_id}</code>
          </p>
        ))}
        {payload.target && (
          <p>
            Content ID: <code>{payload.target.resource_id}</code>
          </p>
        )}
        <p>
          Draft revision {review.draft.revision}. Review expires{" "}
          {new Date(review.expires_at).toLocaleString()}.
        </p>
      </details>
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
  recipientLabel,
}: {
  operation: PeopleInvitationOperation;
  projects: Record<string, InvitationProject>;
  recipientLabel?: string;
}) {
  const successful = operation.outcomes.filter((o) =>
    ["created", "reused", "notified"].includes(o.status),
  ).length;
  const complete = successful === operation.payload.projects.length;
  return (
    <section
      aria-label="Durable invitation outcomes"
      aria-live="polite"
      style={{ overflowWrap: "anywhere" }}
    >
      <Alert
        type={complete ? "success" : "info"}
        title={
          complete
            ? `Invited ${recipientLabel ?? "this person"} to ${successful} ${successful === 1 ? "project" : "projects"}`
            : "Some invitations still need attention"
        }
        description="Access offers still require acceptance. Message delivery is shown separately below."
      />
      <div>
        {operation.outcomes.map((outcome) => (
          <div
            key={outcome.child_operation_id}
            className="invitation-summary-row"
            style={{ borderBottom: `1px solid ${UI_COLORS.border}` }}
          >
            <strong>
              {projects[outcome.project_id]?.title ?? outcome.project_id}
            </strong>
            <span>{statusLabels[outcome.status]}</span>
            <div>
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
            </div>
          </div>
        ))}
      </div>
      <Typography.Paragraph type="secondary" className="invitation-help">
        Successful actions are retained. Checking status never sends another
        invitation.
      </Typography.Paragraph>
      <details className="invitation-help">
        <summary>Technical details</summary>
        Operation <code>{operation.operation_id}</code>: {operation.status}
      </details>
    </section>
  );
}
