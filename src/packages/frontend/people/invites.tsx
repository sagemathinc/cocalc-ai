/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { TimeAgo } from "@cocalc/frontend/components";
import { AddCollaborators } from "@cocalc/frontend/collaborators";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  ProjectCollabInviteRow,
  ProjectCollabInviteStatus,
} from "@cocalc/conat/hub/api/projects";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { peopleApi } from "./api";
import { useCollaboratorProjects } from "./new-conversation";

type Direction = "outbound" | "inbound";

export function inviteeLabel(invite: ProjectCollabInviteRow): string {
  return (
    invite.invitee_name ||
    [invite.invitee_first_name, invite.invitee_last_name]
      .filter(Boolean)
      .join(" ") ||
    invite.target_email ||
    invite.invitee_email_address ||
    "Someone"
  );
}

export function inviterLabel(invite: ProjectCollabInviteRow): string {
  return (
    invite.inviter_name ||
    [invite.inviter_first_name, invite.inviter_last_name]
      .filter(Boolean)
      .join(" ") ||
    "Someone"
  );
}

const STATUS_COLOR: Record<ProjectCollabInviteStatus, string> = {
  pending: "blue",
  accepted: "green",
  declined: "default",
  blocked: "red",
  expired: "default",
  canceled: "default",
};

function useInvites(direction: Direction, status?: ProjectCollabInviteStatus) {
  const [invites, setInvites] = useState<ProjectCollabInviteRow[]>();
  const [unavailable, setUnavailable] = useState(0);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setError("");
    void peopleApi()
      .listInvites({ direction, status })
      .then((result) => {
        setInvites(result.invites);
        setUnavailable(result.unavailable_bays);
      })
      .catch((err) => setError(`${err}`));
  }, [direction, status]);
  useEffect(load, [load]);
  return { invites, unavailable, error, reload: load };
}

// Everyone you invited (across all bays) and invitations you received, with
// the invitation link for email invites so you can send it another way.
export function InvitesPanel({ search }: { search: string }) {
  const [direction, setDirection] = useState<Direction>("outbound");
  const [status, setStatus] = useState<ProjectCollabInviteStatus | "all">(
    "pending",
  );
  const [inviting, setInviting] = useState(false);
  const { invites, unavailable, error, reload } = useInvites(
    direction,
    status === "all" ? undefined : status,
  );
  const [message, setMessage] = useState("");
  const hub = webapp_client.conat_client.hub;
  const q = search.trim().toLowerCase();
  const shown = (invites ?? []).filter(
    (invite) =>
      !q ||
      `${invite.project_title ?? ""} ${inviteeLabel(invite)} ${inviterLabel(invite)}`
        .toLowerCase()
        .includes(q),
  );

  async function act(
    invite: ProjectCollabInviteRow,
    action: "accept" | "decline" | "revoke",
  ) {
    setMessage("");
    try {
      await hub.projects.respondCollabInvite({
        invite_id: invite.invite_id,
        project_id: invite.project_id,
        action,
      });
      setMessage(
        action === "accept"
          ? `You joined ${invite.project_title ?? "the project"}.`
          : action === "decline"
            ? "Invitation declined."
            : "Invitation revoked.",
      );
      reload();
    } catch (err) {
      setMessage(`${err}`);
    }
  }

  async function copyLink(invite: ProjectCollabInviteRow) {
    setMessage("");
    try {
      const { invite_url } = await hub.projects.copyEmailProjectInviteLink({
        invite_id: invite.invite_id,
        project_id: invite.project_id,
        invite_base_url: location.origin,
      });
      await navigator.clipboard.writeText(invite_url);
      setMessage("Invitation link copied. You can send it any way you like.");
    } catch (err) {
      setMessage(`${err}`);
    }
  }

  return (
    <div style={{ maxWidth: 1000 }}>
      <Space wrap style={{ marginBottom: 12 }}>
        <Segmented
          aria-label="Invitations"
          value={direction}
          onChange={(value) => setDirection(value as Direction)}
          options={[
            { value: "outbound", label: "Sent" },
            { value: "inbound", label: "Received" },
          ]}
        />
        <Select
          aria-label="Invitation status"
          value={status}
          onChange={setStatus}
          style={{ minWidth: 140 }}
          options={[
            { value: "pending", label: "Pending" },
            { value: "accepted", label: "Accepted" },
            { value: "declined", label: "Declined" },
            { value: "expired", label: "Expired" },
            { value: "canceled", label: "Revoked" },
            { value: "all", label: "All" },
          ]}
        />
        <Button onClick={reload}>Refresh</Button>
        <Button type="primary" onClick={() => setInviting(true)}>
          Invite people
        </Button>
      </Space>
      {message && <Alert role="status" type="info" title={message} closable />}
      {error && <Alert role="alert" type="error" title={error} />}
      {unavailable > 0 && (
        <Alert
          type="warning"
          role="status"
          title="Some invitations could not be loaded right now; try Refresh."
        />
      )}
      {invites == null ? (
        <p role="status">Loading invitations...</p>
      ) : shown.length === 0 ? (
        <Typography.Paragraph type="secondary">
          No {status === "all" ? "" : `${status} `}invitations{" "}
          {direction === "outbound" ? "sent" : "received"}.
        </Typography.Paragraph>
      ) : (
        <div role="list" aria-label="Invitations">
          {shown.map((invite) => (
            <div
              role="listitem"
              key={invite.invite_id}
              style={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 12,
                padding: "8px 12px",
                border: `1px solid ${UI_COLORS.border}`,
                marginTop: -1,
                background: UI_COLORS.surface,
              }}
            >
              <span style={{ flex: "2 1 200px", minWidth: 0 }}>
                <strong>{invite.project_title || "Untitled project"}</strong>
                <span style={{ color: UI_COLORS.secondary, marginLeft: 8 }}>
                  {direction === "outbound"
                    ? `to ${inviteeLabel(invite)}`
                    : `from ${inviterLabel(invite)}`}
                  {invite.invite_source === "email" ? " (email)" : ""}
                </span>
                {invite.message && (
                  <div style={{ color: UI_COLORS.secondary, fontSize: 13 }}>
                    {invite.message}
                  </div>
                )}
              </span>
              <span style={{ color: UI_COLORS.secondary, fontSize: 13 }}>
                <TimeAgo date={new Date(invite.created)} />
              </span>
              <Tag color={STATUS_COLOR[invite.status]}>
                {invite.status === "canceled" ? "revoked" : invite.status}
              </Tag>
              {invite.status === "pending" && direction === "outbound" && (
                <Space>
                  {invite.invite_source !== "account" && (
                    <Button size="small" onClick={() => void copyLink(invite)}>
                      Copy invitation link
                    </Button>
                  )}
                  <Button
                    size="small"
                    onClick={() => void act(invite, "revoke")}
                  >
                    Revoke
                  </Button>
                </Space>
              )}
              {invite.status === "pending" && direction === "inbound" && (
                <Space>
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => void act(invite, "accept")}
                  >
                    Accept
                  </Button>
                  <Button
                    size="small"
                    onClick={() => void act(invite, "decline")}
                  >
                    Decline
                  </Button>
                </Space>
              )}
            </div>
          ))}
        </div>
      )}
      <InvitePeopleModal
        open={inviting}
        onClose={() => {
          setInviting(false);
          reload();
        }}
      />
    </div>
  );
}

// Choose a project, then use the existing collaborator search and email
// invitation form for it.
export function InvitePeopleModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const projects = useCollaboratorProjects();
  const [project_id, setProjectId] = useState<string>();
  return (
    <Modal
      open={open}
      title="Invite people"
      footer={null}
      width={760}
      onCancel={onClose}
      destroyOnHidden
    >
      <Select
        aria-label="Project to invite to"
        showSearch
        optionFilterProp="label"
        placeholder="Choose a project"
        style={{ width: "100%", marginBottom: 12 }}
        value={project_id}
        onChange={setProjectId}
        options={projects.map((p) => ({ value: p.project_id, label: p.title }))}
      />
      {project_id && (
        <AddCollaborators project_id={project_id} where="people" autoFocus />
      )}
    </Modal>
  );
}

// Invite one known person to several of your projects at once.
export function InviteToProjectsModal({
  open,
  account_id,
  name,
  onClose,
}: {
  open: boolean;
  account_id: string;
  name: string;
  onClose: () => void;
}) {
  const project_map = useTypedRedux("projects", "project_map");
  const mine = useCollaboratorProjects();
  const candidates = mine.filter(
    (p) => !project_map?.getIn([p.project_id, "users", account_id]),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  async function send() {
    setBusy(true);
    const lines: string[] = [];
    for (const p of candidates.filter((c) => selected.has(c.project_id))) {
      try {
        const { created } =
          await webapp_client.conat_client.hub.projects.createCollabInvite({
            project_id: p.project_id,
            invitee_account_id: account_id,
            message: note.trim() || undefined,
            browser_id: webapp_client.browser_id,
          });
        lines.push(`${p.title}: ${created ? "invited" : "already invited"}`);
      } catch (err) {
        lines.push(`${p.title}: ${`${err}`.replace(/^Error: /, "")}`);
      }
    }
    setResults(lines);
    setSelected(new Set());
    setBusy(false);
  }
  return (
    <Modal
      open={open}
      title={`Invite ${name} to projects`}
      okText={`Invite to ${selected.size} ${selected.size === 1 ? "project" : "projects"}`}
      okButtonProps={{ disabled: selected.size === 0 }}
      confirmLoading={busy}
      onOk={() => void send()}
      onCancel={() => {
        setResults([]);
        onClose();
      }}
      destroyOnHidden
    >
      {candidates.length === 0 ? (
        <Typography.Paragraph type="secondary">
          {name} is already in all of your projects.
        </Typography.Paragraph>
      ) : (
        <div
          role="group"
          aria-label="Projects"
          style={{
            maxHeight: 260,
            overflowY: "auto",
            border: `1px solid ${UI_COLORS.border}`,
            borderRadius: 6,
            padding: "4px 8px",
            marginBottom: 8,
          }}
        >
          {candidates.map((p) => (
            <div key={p.project_id}>
              <Checkbox
                checked={selected.has(p.project_id)}
                onChange={(e) =>
                  setSelected((set) => {
                    const next = new Set(set);
                    if (e.target.checked) next.add(p.project_id);
                    else next.delete(p.project_id);
                    return next;
                  })
                }
              >
                {p.title}
              </Checkbox>
            </div>
          ))}
        </div>
      )}
      <Input.TextArea
        aria-label="Message"
        placeholder="Optional message"
        rows={2}
        maxLength={1000}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      {results.length > 0 && (
        <ul role="status" style={{ marginTop: 8 }}>
          {results.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
