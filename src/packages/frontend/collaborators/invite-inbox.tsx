/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Card, Collapse, Divider, Space, Tag } from "antd";
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
import { COLORS } from "@cocalc/util/theme";
import { setUnreadIncomingInviteCount } from "./invite-count";
import {
  notifyCollabInvitesChanged,
  onCollabInvitesChanged,
} from "./invite-events";

const { Panel } = Collapse;

type Props = {
  project_id?: string;
  mode?: "project" | "global";
  showWhenEmpty?: boolean;
};

type UseInviteInboxStateOptions = {
  project_id?: string;
  includeIncoming?: boolean;
  includeOutgoing?: boolean;
  includeBlocks?: boolean;
};

export type InviteInboxState = {
  loading: boolean;
  error: string;
  busy: string;
  incoming: ProjectCollabInviteRow[];
  outgoing: ProjectCollabInviteRow[];
  blocks: ProjectCollabInviteBlockRow[];
  load: () => Promise<void>;
  respond: (
    invite_id: string,
    action: ProjectCollabInviteAction,
  ) => Promise<void>;
  unblock: (blocked_account_id: string) => Promise<void>;
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
    out.push(
      `You previously accepted ${accepted} invite${accepted === 1 ? "" : "s"} from this user.`,
    );
  }
  const declined = invite.prior_invites_declined ?? 0;
  if (declined > 0) {
    out.push(
      `You previously declined ${declined} invite${declined === 1 ? "" : "s"} from this user.`,
    );
  }
  return out;
}

function inviteeLabel(invite: ProjectCollabInviteRow): string {
  return (
    `${invite.invitee_name ?? ""}`.trim() ||
    `${invite.invitee_first_name ?? ""} ${invite.invitee_last_name ?? ""}`.trim() ||
    `${invite.invitee_email_address ?? ""}`.trim() ||
    `${invite.invitee_account_id ?? ""}`.trim() ||
    "Unknown user"
  );
}

export function useInviteInboxState({
  project_id,
  includeIncoming = true,
  includeOutgoing = true,
  includeBlocks = true,
}: UseInviteInboxStateOptions): InviteInboxState {
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
        includeIncoming
          ? webapp_client.project_collaborators.list_invites({
              project_id,
              direction: "inbound",
              status: "pending",
              limit: 200,
            })
          : Promise.resolve([]),
        includeOutgoing
          ? webapp_client.project_collaborators.list_invites({
              project_id,
              direction: "outbound",
              status: "pending",
              limit: 200,
            })
          : Promise.resolve([]),
        includeBlocks
          ? webapp_client.project_collaborators.list_invite_blocks({
              limit: 200,
            })
          : Promise.resolve([]),
      ]);
      const nextIncoming = incomingRows ?? [];
      set_incoming(nextIncoming);
      set_outgoing(outgoingRows ?? []);
      set_blocks(blockRows ?? []);
      if (project_id == null && includeIncoming) {
        setUnreadIncomingInviteCount(nextIncoming.length);
      }
    } catch (err) {
      set_error(`${err}`);
    } finally {
      set_loading(false);
    }
  }, [includeBlocks, includeIncoming, includeOutgoing, project_id]);

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
      await webapp_client.project_collaborators.respond_invite({
        invite_id,
        action,
      });
      await load();
      notifyCollabInvitesChanged(project_id);
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
      await webapp_client.project_collaborators.unblock_inviter({
        blocked_account_id,
      });
      await load();
      notifyCollabInvitesChanged(project_id);
    } catch (err) {
      set_error(`${err}`);
    } finally {
      set_busy("");
    }
  }

  return {
    loading,
    error,
    busy,
    incoming,
    outgoing,
    blocks,
    load,
    respond,
    unblock,
  };
}

function renderIncomingCards(
  incoming: ProjectCollabInviteRow[],
  busy: string,
  respond: InviteInboxState["respond"],
): React.JSX.Element {
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
        const project = `${invite.project_title ?? invite.project_id}`;
        return (
          <Card
            key={invite.invite_id}
            size="small"
            style={{ marginBottom: "8px" }}
            styles={{ body: { padding: "10px" } }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: "8px",
              }}
            >
              <div>
                <div>
                  <strong>{project}</strong>
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
                      border: `1px solid ${COLORS.GRAY_L0}`,
                      borderRadius: "4px",
                      background: COLORS.GRAY_LLL,
                    }}
                  >
                    <div style={{ fontSize: "12px", opacity: 0.75 }}>
                      Message from inviter
                    </div>
                    <Markdown value={invite.message.trim()} />
                  </div>
                )}
                {inviteTrustSignals(invite).map((signal, i) => (
                  <div
                    key={`${invite.invite_id}:signal:${i}`}
                    style={{ fontSize: "12px", opacity: 0.9 }}
                  >
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

export function IncomingInviteBanner({
  state,
  onReview,
}: {
  state: InviteInboxState;
  onReview: () => void;
}): React.JSX.Element | null {
  const { loading, error, incoming } = state;
  if (!loading && !error && incoming.length === 0) {
    return null;
  }
  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        style={{ marginBottom: "12px" }}
        title="Unable to load project invitations."
        description={error}
      />
    );
  }
  if (loading) {
    return null;
  }
  const count = incoming.length;
  return (
    <Alert
      type="info"
      showIcon
      style={{ marginBottom: "12px" }}
      title={`${count} project invitation${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} your response.`}
      action={
        <Button size="small" type="primary" onClick={onReview}>
          Review
        </Button>
      }
    />
  );
}

export function IncomingInvitesNotificationSection({
  state,
}: {
  state: InviteInboxState;
}): React.JSX.Element | null {
  const { loading, error, incoming, busy, respond, load } = state;
  if (!loading && !error && incoming.length === 0) {
    return null;
  }
  return (
    <Collapse
      defaultActiveKey={["project-invitations"]}
      className="cocalc-notification-list"
    >
      <Panel
        key="project-invitations"
        header={
          <>
            <Icon name="mail" style={{ marginRight: "10px" }} />
            Project Invitations ({incoming.length})
          </>
        }
        extra={
          <Button
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              void load();
            }}
            disabled={loading}
          >
            <Icon name="refresh" /> Refresh
          </Button>
        }
      >
        <Paragraph type="secondary">
          Accept or decline pending invitations to collaborate on projects.
        </Paragraph>
        {error && (
          <Alert
            style={{ marginBottom: "10px" }}
            type="error"
            showIcon
            title={error}
          />
        )}
        {loading ? <Loading /> : renderIncomingCards(incoming, busy, respond)}
      </Panel>
    </Collapse>
  );
}

export const InviteInboxPanel: React.FC<Props> = ({
  project_id,
  mode = "global",
  showWhenEmpty = false,
}) => {
  const [expanded, set_expanded] = useState<boolean | undefined>(undefined);
  const projectMode = mode === "project";
  const {
    loading,
    error,
    busy,
    incoming,
    outgoing,
    blocks,
    load,
    respond,
    unblock,
  } = useInviteInboxState({
    project_id,
    includeIncoming: !projectMode,
    includeOutgoing: true,
    includeBlocks: !projectMode,
  });

  const total = useMemo(() => {
    if (projectMode) {
      return outgoing.length;
    }
    return incoming.length + outgoing.length + blocks.length;
  }, [blocks.length, incoming.length, outgoing.length, projectMode]);

  useEffect(() => {
    if (loading || expanded !== undefined) return;
    set_expanded(projectMode ? outgoing.length > 0 : incoming.length > 0);
  }, [expanded, incoming.length, loading, outgoing.length, projectMode]);

  if (!loading && !error && total === 0 && !showWhenEmpty) {
    return null;
  }

  const isExpanded = expanded ?? false;

  function renderIncoming(): React.JSX.Element {
    return renderIncomingCards(incoming, busy, respond);
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
          const invitee = inviteeLabel(invite);
          const project = `${invite.project_title ?? invite.project_id}`;
          return (
            <Card
              key={invite.invite_id}
              size="small"
              style={{ marginBottom: "8px" }}
              styles={{ body: { padding: "10px" } }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "8px",
                }}
              >
                <div>
                  <div>
                    <strong>{project}</strong>
                  </div>
                  <div>
                    To <strong>{invitee}</strong>
                  </div>
                  {invite.invite_source === "email" && (
                    <div style={{ fontSize: "12px", opacity: 0.75 }}>
                      Waiting for this email invite to be claimed or revoked.
                    </div>
                  )}
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
                        border: `1px solid ${COLORS.GRAY_L0}`,
                        borderRadius: "4px",
                        background: COLORS.GRAY_LLL,
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
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "8px",
                }}
              >
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

  const titleBase = projectMode ? "Pending Invitations" : "Invitation Inbox";
  const titleCount = projectMode ? outgoing.length : incoming.length;
  const title = `${titleBase} (${titleCount})`;
  const subtitle = projectMode
    ? "Track pending invitations for this project and revoke them when needed."
    : "Accept, decline, block, or revoke pending collaboration invitations. Pending invites expire automatically.";
  const titleNode = (
    <Button
      type="text"
      size="small"
      onClick={() => set_expanded(!isExpanded)}
      style={{ paddingInline: 0, height: "auto", fontWeight: 600 }}
    >
      <Icon name={isExpanded ? "caret-down" : "caret-right"} /> {title}
    </Button>
  );

  return (
    <SettingBox title={titleNode} icon="mail">
      {!isExpanded ? null : (
        <>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: "8px",
            }}
          >
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
          {projectMode ? (
            <>
              <div style={{ marginBottom: "6px" }}>
                <Tag color="purple">{outgoing.length} pending</Tag>
              </div>
              <div style={{ marginTop: "8px" }}>{renderOutgoing()}</div>
            </>
          ) : (
            <>
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
            </>
          )}
        </>
      )}
    </SettingBox>
  );
};
