/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Popconfirm,
  Select,
  Space,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { Collection } from "@cocalc/frontend/components/collection";
import type { CollectionView } from "@cocalc/frontend/components/collection";
import type {
  PeopleInvitationHistoryPage,
  PeopleInvitationHistoryQuery,
  PeopleInvitationHistoryRow,
} from "@cocalc/util/people-invitation-history";
import { onCollabInvitesChanged } from "./invite-events";
import { InvitationContentLink } from "./invitation-content-link";

export interface InvitationHistoryApi {
  listInvitationHistory(
    input: Omit<PeopleInvitationHistoryQuery, "account_id">,
  ): Promise<PeopleInvitationHistoryPage>;
  manage(
    row: PeopleInvitationHistoryRow,
    action: "accept" | "decline" | "revoke" | "resend" | "copy" | "dismiss",
  ): Promise<string | void>;
}

/** A contact ID is never passed as an account ID to project/chat APIs. */
export function InvitationHistory({
  api,
  personId,
  participantAccountId,
  search,
  invitationId,
  projectIds,
  active = true,
  onOpen,
  projectTitle,
  onClearInvitation,
  collectionView = "list",
}: {
  api: InvitationHistoryApi;
  personId?: string;
  participantAccountId?: string;
  search?: string;
  invitationId?: string;
  projectIds?: string[];
  active?: boolean;
  onOpen?: (row: PeopleInvitationHistoryRow) => void;
  projectTitle?: (projectId: string) => string | undefined;
  onClearInvitation?: () => void;
  collectionView?: CollectionView;
}) {
  const [view, setView] = useState<"sent" | "received" | "history">(
    invitationId ? "received" : "sent",
  );
  const [focusedId, setFocusedId] = useState(invitationId);
  const [kind, setKind] = useState<"access" | "collaboration">();
  const [status, setStatus] = useState<PeopleInvitationHistoryRow["status"]>();
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState<PeopleInvitationHistoryPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const generation = useRef(0);
  const queryKey = JSON.stringify([
    view,
    kind,
    status,
    personId,
    participantAccountId,
    search,
    projectIds,
    focusedId,
  ]);
  const visibleKey = useRef(queryKey);
  const latest = useRef({ api, active, queryKey });
  if (
    latest.current.api !== api ||
    latest.current.active !== active ||
    latest.current.queryKey !== queryKey
  )
    latest.current = { api, active, queryKey };
  const query: Omit<PeopleInvitationHistoryQuery, "account_id"> = {
    view,
    kind,
    status,
    person_id: personId,
    invitation_id: focusedId,
    participant_account_id: participantAccountId,
    search,
    project_ids: projectIds,
    limit: 25,
  };
  async function load(after?: string) {
    if (!active) return;
    const run = ++generation.current;
    const start = latest.current;
    const current = () =>
      run === generation.current && latest.current === start;
    setLoading(true);
    setError(undefined);
    try {
      const result = await api.listInvitationHistory({ ...query, after });
      if (!current()) return;
      visibleKey.current = queryKey;
      setPage((before) => ({
        ...result,
        items:
          after && before
            ? [
                ...new Map(
                  [...before.items, ...result.items].map((row) => [
                    `${row.kind}:${row.invitation_id}`,
                    row,
                  ]),
                ).values(),
              ]
            : result.items,
      }));
    } catch (err) {
      if (current()) {
        setPage(undefined);
        setError(String(err));
      }
    } finally {
      if (current()) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [api, active, queryKey, refresh]);
  useEffect(() => onCollabInvitesChanged(() => setRefresh((n) => n + 1)), []);
  useEffect(() => {
    setFocusedId(invitationId);
    if (invitationId) setView("received");
  }, [invitationId]);
  const shown = active && visibleKey.current === queryKey ? page : undefined;

  async function manage(
    row: PeopleInvitationHistoryRow,
    action: Parameters<InvitationHistoryApi["manage"]>[1],
  ) {
    const start = latest.current;
    setBusy(row.invitation_id);
    setFeedback(undefined);
    setError(undefined);
    try {
      const message = await api.manage(row, action);
      if (latest.current !== start) return;
      setFeedback(
        message ||
          (action === "copy"
            ? "Invitation link copied."
            : "Invitation updated."),
      );
      if (action !== "copy") setRefresh((n) => n + 1);
    } catch (err) {
      if (latest.current === start) setError(String(err));
    } finally {
      if (latest.current === start) setBusy(undefined);
    }
  }

  return (
    <section
      aria-label="Invitation history"
      style={{ padding: 12, minWidth: 0 }}
    >
      <Tabs
        aria-label="Invitation direction"
        activeKey={view}
        onChange={(key) => {
          setView(key as typeof view);
          setStatus(undefined);
        }}
        items={[
          { key: "sent", label: "Sent" },
          { key: "received", label: "Received" },
          { key: "history", label: "History" },
        ]}
      />
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          aria-label="Invitation kind"
          value={kind ?? "all"}
          onChange={(value) =>
            setKind(
              value === "all"
                ? undefined
                : (value as "access" | "collaboration"),
            )
          }
          options={[
            { value: "all", label: "All invitation kinds" },
            { value: "access", label: "Project access" },
            { value: "collaboration", label: "Work together" },
          ]}
          style={{ minWidth: 180 }}
        />
        <Select
          aria-label="Invitation status"
          value={status ?? "all"}
          onChange={(value) =>
            setStatus(
              value === "all"
                ? undefined
                : (value as PeopleInvitationHistoryRow["status"]),
            )
          }
          options={[
            { value: "all", label: "All statuses" },
            ...[
              "pending",
              "accepted",
              "declined",
              "blocked",
              "expired",
              "canceled",
              "active",
              "withdrawn",
            ].map((value) => ({
              value,
              label: value === "canceled" ? "Revoked" : value,
            })),
          ]}
          style={{ minWidth: 140 }}
        />
        <Button disabled={loading} onClick={() => setRefresh((n) => n + 1)}>
          Refresh invitations
        </Button>
      </Space>
      <details style={{ marginBottom: 12 }}>
        <summary>About invitations</summary>
        <p>
          Access offers and invitations to work together are separate.
          Acceptance history does not guarantee current project access.
        </p>
      </details>
      {focusedId && (
        <Button
          onClick={() => {
            setFocusedId(undefined);
            onClearInvitation?.();
          }}
        >
          Show all invitations
        </Button>
      )}
      {feedback && <p role="status">{feedback}</p>}
      {error && (
        <Alert
          role="alert"
          type="error"
          title="Unable to update invitations"
          description={error}
          action={
            <Button onClick={() => setRefresh((n) => n + 1)}>
              Retry invitations
            </Button>
          }
        />
      )}
      {loading && <p role="status">Loading invitations...</p>}
      {shown && (
        <>
          {shown.coverage !== "complete" && (
            <Alert
              role="status"
              type="warning"
              title="Invitation history is still being synchronized"
              description={
                shown.coverage_message ||
                "Some invitations may not be listed yet."
              }
            />
          )}
          <p role="status">
            {shown.total} matching invitations. Pending: {shown.pending.sent}{" "}
            sent, {shown.pending.received} received.
          </p>
          {!shown.items.length && <p>No invitations match these filters.</p>}
          <Collection
            items={shown.items}
            itemId={(row) => `${row.kind}:${row.invitation_id}`}
            itemTitle={(row) =>
              projectTitle?.(row.project_id) || "Project invitation"
            }
            pins={[]}
            view={collectionView}
            otherTitle="Invitations"
            renderItem={(row) => (
              <Card size="small" style={{ marginBottom: 10 }}>
                <InvitationHistoryItem
                  row={row}
                  direction={view}
                  busy={busy === row.invitation_id}
                  onAction={(action) => void manage(row, action)}
                  onOpen={onOpen ? () => onOpen(row) : undefined}
                  projectTitle={projectTitle?.(row.project_id)}
                />
              </Card>
            )}
          />
          {shown.next && (
            <Button disabled={loading} onClick={() => void load(shown.next)}>
              Load more invitations
            </Button>
          )}
        </>
      )}
    </section>
  );
}

function InvitationHistoryItem({
  row,
  direction,
  busy,
  onAction,
  onOpen,
  projectTitle,
}: {
  row: PeopleInvitationHistoryRow;
  direction: "sent" | "received" | "history";
  busy: boolean;
  onAction: (action: Parameters<InvitationHistoryApi["manage"]>[1]) => void;
  onOpen?: () => void;
  projectTitle?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const person =
    direction === "received"
      ? `From ${row.sender_label || "a collaborator"}`
      : `To ${row.recipient_label || (row.recipient_account_id ? "a collaborator" : "email contact")}`;
  return (
    <>
      <Space wrap>
        <strong style={{ overflowWrap: "anywhere" }}>
          {row.kind === "collaboration" && row.target?.label
            ? row.target.label
            : projectTitle || "Project invitation"}
        </strong>
        <Tag>{row.status === "canceled" ? "Revoked" : row.status}</Tag>
      </Space>
      <Typography.Paragraph type="secondary" style={{ margin: "4px 0" }}>
        {person} ·{" "}
        {row.kind === "access" ? `${row.role} access` : "Work together"} ·{" "}
        {new Date(row.created_at).toLocaleDateString()}
      </Typography.Paragraph>
      {row.message && (
        <Typography.Paragraph
          ellipsis={{ rows: 1 }}
          style={{ margin: "4px 0" }}
        >
          {row.message}
        </Typography.Paragraph>
      )}
      <Button
        type="link"
        size="small"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? "Hide details" : "Details and actions"}
      </Button>
      {expanded && (
        <div style={{ marginTop: 8, overflowWrap: "anywhere" }}>
          <p>Project: {projectTitle || row.project_id}</p>
          {row.kind === "collaboration" && row.target?.label && (
            <p>Work together on: {row.target.label}</p>
          )}
          {row.kind === "access" && (
            <p>
              Offered role: {row.role}. This is project access, not access only
              to a linked item.
            </p>
          )}
          {row.message && (
            <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {row.message}
            </p>
          )}
          <p>Created {new Date(row.created_at).toLocaleString()}</p>
          {row.kind === "access" && row.invite_source === "email" && (
            <p>
              {row.last_sent_at
                ? `Email submitted ${new Date(row.last_sent_at).toLocaleString()}.`
                : "No email delivery has been recorded. Copy the invitation link to deliver it yourself."}
            </p>
          )}
          {row.kind === "access" && row.accepted_account_id && (
            <p>
              Accepted by account {row.accepted_account_id}. An accepted email
              link alone does not verify the contact's identity.
            </p>
          )}
          {row.kind === "collaboration" &&
            row.delivery.map((receipt, index) => (
              <p key={`${receipt.channel}:${index}`}>
                {receipt.channel}: {receipt.status}
                {receipt.reason ? ` (${receipt.reason})` : ""}.
              </p>
            ))}
          <Space wrap>
            {row.kind === "access" &&
              row.status === "pending" &&
              direction === "received" && (
                <>
                  <Popconfirm
                    title={`Accept ${row.role} access to this project?`}
                    onConfirm={() => onAction("accept")}
                    okText="Accept"
                    cancelText="Cancel"
                  >
                    <Button disabled={busy} type="primary">
                      Accept access
                    </Button>
                  </Popconfirm>
                  <Button disabled={busy} onClick={() => onAction("decline")}>
                    Decline
                  </Button>
                </>
              )}
            {row.kind === "access" &&
              row.status === "pending" &&
              direction === "sent" && (
                <>
                  <Popconfirm
                    title="Revoke this pending access offer?"
                    description="Existing project access will not be removed."
                    onConfirm={() => onAction("revoke")}
                    okText="Revoke"
                    cancelText="Cancel"
                  >
                    <Button danger disabled={busy}>
                      Revoke
                    </Button>
                  </Popconfirm>
                  {row.invite_source === "email" && (
                    <Popconfirm
                      title="Resend this invitation email?"
                      description="The existing invitation and its access level will stay unchanged."
                      okText="Resend"
                      cancelText="Cancel"
                      onConfirm={() => onAction("resend")}
                    >
                      <Button disabled={busy}>Resend email</Button>
                    </Popconfirm>
                  )}
                  {row.invite_source === "email" && (
                    <Button disabled={busy} onClick={() => onAction("copy")}>
                      Copy invitation link
                    </Button>
                  )}
                </>
              )}
            {row.kind === "collaboration" &&
              direction === "received" &&
              row.status === "active" &&
              !!row.notification_id &&
              !row.notification_archived && (
                <Button disabled={busy} onClick={() => onAction("dismiss")}>
                  Dismiss
                </Button>
              )}
            {row.kind === "collaboration" && row.target ? (
              <InvitationContentLink
                target={row.target}
                projectId={row.target.project_id}
              />
            ) : onOpen &&
              (row.status === "accepted" || row.kind === "collaboration") ? (
              <Button onClick={onOpen}>Open project</Button>
            ) : null}
          </Space>
          <details style={{ marginTop: 8 }}>
            <summary>Technical details</summary>
            <p>
              Sender: <code>{row.sender_account_id}</code>
            </p>
            <p>
              Recipient:{" "}
              <code>{row.recipient_account_id ?? "email contact"}</code>
            </p>
            <p>
              Invitation: <code>{row.invitation_id}</code>
            </p>
          </details>
        </div>
      )}
    </>
  );
}
