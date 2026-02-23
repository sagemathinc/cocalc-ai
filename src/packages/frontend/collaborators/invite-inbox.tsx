/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Card, Divider, Space, Tag } from "antd";
import type {
  ProjectCollabInviteAction,
  ProjectCollabInviteBlockRow,
  ProjectCollabInviteRow,
} from "@cocalc/conat/hub/api/projects";
import {
  React,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "@cocalc/frontend/app-framework";
import {
  Gap,
  Icon,
  Loading,
  Markdown,
  Paragraph,
  SettingBox,
} from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { onCollabInvitesChanged } from "./invite-events";

type Props = {
  project_id?: string;
  mode?: "project" | "global";
  showWhenEmpty?: boolean;
};

function formatTime(value: Date | string | null | undefined): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.valueOf())) return "";
  return d.toLocaleString();
}

function userName(
  value:
    | {
        name?: string | null;
        first?: string | null;
        last?: string | null;
        account_id?: string | null;
      }
    | undefined,
): string {
  if (!value) return "Unknown user";
  return (
    `${value.name ?? ""}`.trim() ||
    `${value.first ?? ""} ${value.last ?? ""}`.trim() ||
    `${value.account_id ?? ""}`.trim() ||
    "Unknown user"
  );
}

function inviteTrustSignals(invite: ProjectCollabInviteRow): string[] {
  const out: string[] = [];
  const sharedCount = invite.shared_projects_count ?? 0;
  const sharedSample = (invite.shared_projects_sample ?? []).filter((x) => !!x);
  if (sharedCount > 0) {
    let mesg = `You already collaborate together on ${sharedCount} other project${sharedCount === 1 ? "" : "s"}`;
    if (sharedSample.length > 0) {
      mesg += `: ${sharedSample.join(", ")}`;
      if (sharedCount > sharedSample.length) {
        mesg += ` + ${sharedCount - sharedSample.length} more`;
      }
    }
    out.push(mesg + ".");
  }
  const accepted = invite.prior_invites_accepted ?? 0;
  if (accepted > 0) {
    out.push(`You previously accepted ${accepted} invite${accepted === 1 ? "" : "s"} from this user.`);
  }
  const declined = invite.prior_invites_declined ?? 0;
  if (declined > 0) {
    out.push(`You previously declined ${declined} invite${declined === 1 ? "" : "s"} from this user.`);
  }
  return out;
}

export const InviteInboxPanel: React.FC<Props> = ({
  project_id,
  mode = "global",
  showWhenEmpty = false,
}) => {
  const [loading, set_loading] = useState<boolean>(false);
  const [error, set_error] = useState<string>("");
  const [busy, set_busy] = useState<string>("");
  const [incoming, set_incoming] = useState<ProjectCollabInviteRow[]>([]);
  const [outgoing, set_outgoing] = useState<ProjectCollabInviteRow[]>([]);
  const [blocks, set_blocks] = useState<ProjectCollabInviteBlockRow[]>([]);

  const load = useCallback(async () => {
    set_loading(true);
    set_error("");
    try {
      const [incomingRows, outgoingRows, blockRows] = await Promise.all([
        webapp_client.project_collaborators.list_invites({
          project_id,
          direction: "inbound",
          status: "pending",
          limit: 200,
        }),
        webapp_client.project_collaborators.list_invites({
          project_id,
          direction: "outbound",
          status: "pending",
          limit: 200,
        }),
        webapp_client.project_collaborators.list_invite_blocks({ limit: 200 }),
      ]);
      set_incoming(incomingRows ?? []);
      set_outgoing(outgoingRows ?? []);
      set_blocks(blockRows ?? []);
    } catch (err) {
      set_error(`${err}`);
    } finally {
      set_loading(false);
    }
  }, [project_id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return onCollabInvitesChanged(({ project_id: changedProjectId }) => {
      if (
        project_id == null ||
        changedProjectId == null ||
        changedProjectId === project_id
      ) {
        void load();
      }
    });
  }, [load, project_id]);

  async function respond(invite_id: string, action: ProjectCollabInviteAction) {
    set_busy(`${invite_id}:${action}`);
    set_error("");
    try {
      await webapp_client.project_collaborators.respond_invite({ invite_id, action });
      await load();
    } catch (err) {
      set_error(`${err}`);
    } finally {
      set_busy("");
    }
  }

  async function unblock(blocked_account_id: string) {
    set_busy(`unblock:${blocked_account_id}`);
    set_error("");
    try {
      await webapp_client.project_collaborators.unblock_inviter({ blocked_account_id });
      await load();
    } catch (err) {
      set_error(`${err}`);
    } finally {
      set_busy("");
    }
  }

  const total = useMemo(
    () => incoming.length + outgoing.length + blocks.length,
    [incoming.length, outgoing.length, blocks.length],
  );

  if (!loading && !error && total === 0 && !showWhenEmpty) {
    return null;
  }

  function renderIncoming(): React.JSX.Element {
    if (incoming.length === 0) {
      return (
        <Paragraph type="secondary" style={{ marginBottom: "0" }}>
          No incoming invitations.
        </Paragraph>
      );
    }
    return (
      <div>
        {incoming.map((invite) => {
          const inviter = userName({
            name: invite.inviter_name,
            first: invite.inviter_first_name,
            last: invite.inviter_last_name,
            account_id: invite.inviter_account_id,
          });
          const workspace = `${invite.project_title ?? invite.project_id}`;
          return (
            <Card
              key={invite.invite_id}
              size="small"
              style={{ marginBottom: "8px" }}
              styles={{ body: { padding: "10px" } }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                <div>
                  <div>
                    <strong>{workspace}</strong>
                  </div>
                  <div>
                    From <strong>{inviter}</strong>
                  </div>
                  {!!invite.project_description?.trim() && (
                    <div style={{ marginTop: "4px" }}>
                      {invite.project_description.trim()}
                    </div>
                  )}
                  {!!invite.message?.trim() && (
                    <div
                      style={{
                        marginTop: "6px",
                        padding: "6px 8px",
                        border: "1px solid #e6e6e6",
                        borderRadius: "4px",
                        background: "#fafafa",
                      }}
                    >
                      <div style={{ fontSize: "12px", opacity: 0.75 }}>
                        Message from inviter
                      </div>
                      <Markdown value={invite.message.trim()} />
                    </div>
                  )}
                  {inviteTrustSignals(invite).map((signal, i) => (
                    <div key={`${invite.invite_id}:signal:${i}`} style={{ fontSize: "12px", opacity: 0.9 }}>
                      {signal}
                    </div>
                  ))}
                  <div style={{ fontSize: "12px", opacity: 0.75 }}>
                    Received {formatTime(invite.created)}
                  </div>
                  {!!invite.expires && (
                    <div style={{ fontSize: "12px", opacity: 0.75 }}>
                      Expires {formatTime(invite.expires)}
                    </div>
                  )}
                </div>
                <Space size={6} wrap>
                  <Button
                    size="small"
                    type="primary"
                    loading={busy === `${invite.invite_id}:accept`}
                    onClick={() => void respond(invite.invite_id, "accept")}
                  >
                    Accept
                  </Button>
                  <Button
                    size="small"
                    loading={busy === `${invite.invite_id}:decline`}
                    onClick={() => void respond(invite.invite_id, "decline")}
                  >
                    Decline
                  </Button>
                  <Button
                    size="small"
                    danger
                    loading={busy === `${invite.invite_id}:block`}
                    onClick={() => void respond(invite.invite_id, "block")}
                  >
                    Block
                  </Button>
                </Space>
              </div>
            </Card>
          );
        })}
      </div>
    );
  }

  function renderOutgoing(): React.JSX.Element {
    if (outgoing.length === 0) {
      return (
        <Paragraph type="secondary" style={{ marginBottom: "0" }}>
          No outgoing invitations.
        </Paragraph>
      );
    }
    return (
      <div>
        {outgoing.map((invite) => {
          const invitee = userName({
            name: invite.invitee_name,
            first: invite.invitee_first_name,
            last: invite.invitee_last_name,
            account_id: invite.invitee_account_id,
          });
          const workspace = `${invite.project_title ?? invite.project_id}`;
          return (
            <Card
              key={invite.invite_id}
              size="small"
              style={{ marginBottom: "8px" }}
              styles={{ body: { padding: "10px" } }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                <div>
                  <div>
                    <strong>{workspace}</strong>
                  </div>
                  <div>
                    To <strong>{invitee}</strong>
                  </div>
                  {!!invite.project_description?.trim() && (
                    <div style={{ marginTop: "4px" }}>
                      {invite.project_description.trim()}
                    </div>
                  )}
                  {!!invite.message?.trim() && (
                    <div
                      style={{
                        marginTop: "6px",
                        padding: "6px 8px",
                        border: "1px solid #e6e6e6",
                        borderRadius: "4px",
                        background: "#fafafa",
                      }}
                    >
                      <div style={{ fontSize: "12px", opacity: 0.75 }}>
                        Message you sent
                      </div>
                      <Markdown value={invite.message.trim()} />
                    </div>
                  )}
                  <div style={{ fontSize: "12px", opacity: 0.75 }}>
                    Sent {formatTime(invite.created)}
                  </div>
                  {!!invite.expires && (
                    <div style={{ fontSize: "12px", opacity: 0.75 }}>
                      Expires {formatTime(invite.expires)}
                    </div>
                  )}
                </div>
                <Button
                  size="small"
                  loading={busy === `${invite.invite_id}:revoke`}
                  onClick={() => void respond(invite.invite_id, "revoke")}
                >
                  Revoke
                </Button>
              </div>
            </Card>
          );
        })}
      </div>
    );
  }

  function renderBlocks(): React.JSX.Element {
    if (blocks.length === 0) {
      return (
        <Paragraph type="secondary" style={{ marginBottom: "0" }}>
          No blocked inviters.
        </Paragraph>
      );
    }
    return (
      <div>
        {blocks.map((block) => {
          const blocked = userName({
            name: block.blocked_name,
            first: block.blocked_first_name,
            last: block.blocked_last_name,
            account_id: block.blocked_account_id,
          });
          return (
            <Card
              key={`${block.blocker_account_id}:${block.blocked_account_id}`}
              size="small"
              style={{ marginBottom: "8px" }}
              styles={{ body: { padding: "10px" } }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                <div>
                  <div>
                    <strong>{blocked}</strong>
                  </div>
                  <div style={{ fontSize: "12px", opacity: 0.75 }}>
                    Blocked {formatTime(block.created)}
                  </div>
                </div>
                <Button
                  size="small"
                  loading={busy === `unblock:${block.blocked_account_id}`}
                  onClick={() => void unblock(block.blocked_account_id)}
                >
                  Unblock
                </Button>
              </div>
            </Card>
          );
        })}
      </div>
    );
  }

  const title =
    mode === "project" ? "Workspace Invitations" : "Invitation Inbox";
  const subtitle =
    mode === "project"
      ? "Manage pending invitations for this workspace."
      : "Accept, decline, block, or revoke pending collaboration invitations. Pending invites expire automatically.";

  return (
    <SettingBox title={title} icon="mail">
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {subtitle}
        </Paragraph>
        <Button size="small" onClick={() => void load()} disabled={loading}>
          <Icon name="refresh" /> Refresh
        </Button>
      </div>
      {error && (
        <Alert
          style={{ marginBottom: "10px" }}
          type="error"
          showIcon
          title={error}
        />
      )}
      {loading && (
        <div style={{ marginBottom: "10px" }}>
          <Loading />
        </div>
      )}
      <div style={{ marginBottom: "6px" }}>
        <Tag color="blue">{incoming.length} incoming</Tag>
        <Gap />
        <Tag color="purple">{outgoing.length} outgoing</Tag>
        <Gap />
        <Tag>{blocks.length} blocked</Tag>
      </div>
      <Divider style={{ margin: "10px 0" }} />
      <strong>Incoming invitations</strong>
      <div style={{ marginTop: "8px" }}>{renderIncoming()}</div>
      <Divider style={{ margin: "10px 0" }} />
      <strong>Outgoing invitations</strong>
      <div style={{ marginTop: "8px" }}>{renderOutgoing()}</div>
      <Divider style={{ margin: "10px 0" }} />
      <strong>Blocked inviters</strong>
      <div style={{ marginTop: "8px" }}>{renderBlocks()}</div>
    </SettingBox>
  );
};
