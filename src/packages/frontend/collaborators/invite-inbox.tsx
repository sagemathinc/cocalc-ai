/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Collapse,
  Divider,
  Popconfirm,
  Space,
  Tag,
  message,
} from "antd";
import type {
  ProjectCollabInviteAction,
  ProjectCollabInviteBlockRow,
  ProjectCollabInviteRow,
} from "@cocalc/conat/hub/api/projects";
import {
  React,
  redux,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import {
  Gap,
  Icon,
  Loading,
  Markdown,
  Paragraph,
  SettingBox,
  TimeAgo,
} from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { COLORS } from "@cocalc/util/theme";
import { setUnreadIncomingInviteCount } from "./invite-count";
import {
  notifyCollabInvitesChanged,
  onCollabInvitesChanged,
} from "./invite-events";
import { viewerReadPolicySummary } from "./viewer-read-policy";

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
  projectWideOutgoing?: boolean;
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
  ) => Promise<boolean>;
  copyInviteLink: (invite_id: string) => Promise<void>;
  unblock: (blocked_account_id: string) => Promise<void>;
};

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
    `${invite.target_email ?? ""}`.trim() ||
    `${invite.invitee_account_id ?? ""}`.trim() ||
    "Unknown user"
  );
}

function friendlyRespondError(err: unknown): string {
  const message = `${err}`;
  const match = message.match(/invite is not pending \(status=([^)]+)\)/);
  if (match == null) {
    return message;
  }
  switch (match[1]) {
    case "accepted":
      return "Invite already accepted.";
    case "declined":
      return "Invite already declined.";
    case "blocked":
      return "Invite already blocked.";
    case "canceled":
      return "Invite already revoked.";
    default:
      return "Invite is no longer pending.";
  }
}

function inviteRoleLabel(invite: ProjectCollabInviteRow): React.JSX.Element {
  const role = invite.invite_role === "viewer" ? "viewer" : "collaborator";
  if (role === "viewer") {
    return (
      <Space size={6} wrap>
        <Tag color="gold" style={{ marginInlineEnd: 0 }}>
          Viewer
        </Tag>
        <Tag style={{ marginInlineEnd: 0 }}>
          {viewerReadPolicySummary(invite.read_policy)}
        </Tag>
      </Space>
    );
  }
  return (
    <Tag color="blue" style={{ marginInlineEnd: 0 }}>
      Collaborator
    </Tag>
  );
}

export function useInviteInboxState({
  project_id,
  includeIncoming = true,
  includeOutgoing = true,
  includeBlocks = true,
  projectWideOutgoing = false,
}: UseInviteInboxStateOptions): InviteInboxState {
  const account_id = useTypedRedux("account", "account_id");
  const [loading, set_loading] = useState<boolean>(false);
  const [error, set_error] = useState<string>("");
  const [busy, set_busy] = useState<string>("");
  const [incoming, set_incoming] = useState<ProjectCollabInviteRow[]>([]);
  const [outgoing, set_outgoing] = useState<ProjectCollabInviteRow[]>([]);
  const [blocks, set_blocks] = useState<ProjectCollabInviteBlockRow[]>([]);

  const load = useCallback(async () => {
    if (!account_id) {
      set_loading(false);
      set_error("");
      set_incoming([]);
      set_outgoing([]);
      set_blocks([]);
      if (project_id == null && includeIncoming) {
        setUnreadIncomingInviteCount(0);
      }
      return;
    }
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
              direction: projectWideOutgoing ? "all" : "outbound",
              status: "pending",
              limit: 200,
              projectWide: projectWideOutgoing,
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
  }, [
    account_id,
    includeBlocks,
    includeIncoming,
    includeOutgoing,
    project_id,
    projectWideOutgoing,
  ]);

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

  async function respond(
    invite_id: string,
    action: ProjectCollabInviteAction,
  ): Promise<boolean> {
    set_busy(`${invite_id}:${action}`);
    set_error("");
    try {
      await webapp_client.project_collaborators.respond_invite({
        invite_id,
        project_id,
        action,
      });
      await load();
      notifyCollabInvitesChanged(project_id);
      return true;
    } catch (err) {
      const message = friendlyRespondError(err);
      if (message !== `${err}`) {
        await load();
      }
      set_error(message);
      return false;
    } finally {
      set_busy("");
    }
  }

  async function copyInviteLink(invite_id: string) {
    set_busy(`${invite_id}:copy`);
    set_error("");
    try {
      const result =
        await webapp_client.project_collaborators.copy_email_invite_link({
          invite_id,
          project_id,
        });
      await navigator.clipboard.writeText(result.invite_url);
      void message.success("Invite link copied.");
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
    copyInviteLink,
    unblock,
  };
}

function renderIncomingCards(
  incoming: ProjectCollabInviteRow[],
  busy: string,
  respond: InviteInboxState["respond"],
  onResponded?: (
    invite: ProjectCollabInviteRow,
    action: ProjectCollabInviteAction,
  ) => void,
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
        async function respondToInvite(action: ProjectCollabInviteAction) {
          const ok = await respond(invite.invite_id, action);
          if (ok) {
            onResponded?.(invite, action);
          }
        }
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
                <div style={{ marginTop: 4 }}>{inviteRoleLabel(invite)}</div>
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
                  Received <TimeAgo date={invite.created} />
                </div>
                {!!invite.expires && (
                  <div style={{ fontSize: "12px", opacity: 0.75 }}>
                    Expires <TimeAgo date={invite.expires} />
                  </div>
                )}
              </div>
              <Space size={6} wrap>
                <Button
                  size="small"
                  type="primary"
                  loading={busy === `${invite.invite_id}:accept`}
                  onClick={() => void respondToInvite("accept")}
                >
                  Accept
                </Button>
                <Button
                  size="small"
                  loading={busy === `${invite.invite_id}:decline`}
                  onClick={() => void respondToInvite("decline")}
                >
                  Decline
                </Button>
                <Button
                  size="small"
                  danger
                  loading={busy === `${invite.invite_id}:block`}
                  onClick={() => void respondToInvite("block")}
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

type InviteResponse = {
  invite: ProjectCollabInviteRow;
  action: ProjectCollabInviteAction;
};

function inviteProjectTitle(invite: ProjectCollabInviteRow): string {
  return `${invite.project_title ?? invite.project_id}`;
}

async function openInvitedProject(project_id: string) {
  await (
    redux.getActions("projects") as any
  )?.ensureRealtimeFeedForCurrentAccount?.();
  await redux.getActions("projects").open_project({
    project_id,
    target: "files",
    switch_to: true,
    restore_session: false,
  });
}

function renderInviteResponseCards({
  responses,
  dismiss,
}: {
  responses: InviteResponse[];
  dismiss: (invite_id: string) => void;
}): React.JSX.Element | null {
  if (responses.length === 0) {
    return null;
  }
  return (
    <Space orientation="vertical" style={{ width: "100%", marginBottom: 12 }}>
      {responses.map(({ invite, action }) => {
        const project = inviteProjectTitle(invite);
        const invite_id = invite.invite_id;
        if (action === "accept") {
          return (
            <Alert
              key={invite_id}
              type="success"
              showIcon
              title={`Joined ${project}`}
              description={`You accepted the invitation and now have ${invite.invite_role === "viewer" ? "viewer" : "collaborator"} access.`}
              action={
                <Space wrap>
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => void openInvitedProject(invite.project_id)}
                  >
                    Open project
                  </Button>
                  <Button size="small" onClick={() => dismiss(invite_id)}>
                    Dismiss
                  </Button>
                </Space>
              }
            />
          );
        }
        return (
          <Alert
            key={invite_id}
            type={action === "block" ? "warning" : "info"}
            showIcon
            title={
              action === "block"
                ? `Blocked invitation to ${project}`
                : `Declined invitation to ${project}`
            }
            description={
              action === "block"
                ? "You declined this invitation and blocked further invites from this sender."
                : "You declined this invitation."
            }
            action={
              <Button size="small" onClick={() => dismiss(invite_id)}>
                Dismiss
              </Button>
            }
          />
        );
      })}
    </Space>
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
  const [responses, setResponses] = useState<InviteResponse[]>([]);
  if (!loading && !error && incoming.length === 0 && responses.length === 0) {
    return null;
  }
  function recordResponse(
    invite: ProjectCollabInviteRow,
    action: ProjectCollabInviteAction,
  ) {
    setResponses((responses) => [
      { invite, action },
      ...responses.filter(
        (response) => response.invite.invite_id !== invite.invite_id,
      ),
    ]);
  }
  function dismissResponse(invite_id: string) {
    setResponses((responses) =>
      responses.filter((response) => response.invite.invite_id !== invite_id),
    );
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
            Project Invitations ({incoming.length + responses.length})
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
          Accept or decline pending invitations to collaborate on projects. When
          you accept an invite, you can open the project from here.
        </Paragraph>
        {renderInviteResponseCards({
          responses,
          dismiss: dismissResponse,
        })}
        {error && (
          <Alert
            style={{ marginBottom: "10px" }}
            type="error"
            showIcon
            title={error}
          />
        )}
        {loading ? (
          <Loading />
        ) : incoming.length > 0 || responses.length === 0 ? (
          renderIncomingCards(incoming, busy, respond, recordResponse)
        ) : null}
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
  const account_id = useTypedRedux("account", "account_id");
  const project_map = useTypedRedux("projects", "project_map");
  const projectGroup =
    project_id && account_id
      ? project_map?.getIn([project_id, "users", account_id, "group"])
      : undefined;
  const isProjectOwner = projectGroup === "owner";
  const {
    loading,
    error,
    busy,
    incoming,
    outgoing,
    blocks,
    load,
    respond,
    copyInviteLink,
    unblock,
  } = useInviteInboxState({
    project_id,
    includeIncoming: !projectMode,
    includeOutgoing: true,
    includeBlocks: !projectMode,
    projectWideOutgoing: projectMode,
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

  if (!error && total === 0 && !showWhenEmpty) {
    return null;
  }

  const isExpanded = expanded ?? !!error;

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
          const createdByMe = invite.inviter_account_id === account_id;
          const canCopyEmailLink =
            invite.invite_source === "email" && (createdByMe || isProjectOwner);
          const invitee =
            invite.invite_source === "email" &&
            !invite.target_email &&
            !invite.invitee_email_address
              ? "Email invite"
              : inviteeLabel(invite);
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
                    To <strong>{invitee}</strong>
                  </div>
                  <div style={{ marginTop: 4 }}>{inviteRoleLabel(invite)}</div>
                  <div style={{ fontSize: "12px", opacity: 0.75 }}>
                    Created by <strong>{createdByMe ? "you" : inviter}</strong>
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
                    Sent <TimeAgo date={invite.created} />
                  </div>
                  {!!invite.expires && (
                    <div style={{ fontSize: "12px", opacity: 0.75 }}>
                      Expires <TimeAgo date={invite.expires} />
                    </div>
                  )}
                  {invite.invite_source === "email" && !canCopyEmailLink && (
                    <div
                      style={{
                        color: COLORS.GRAY_M,
                        fontSize: "12px",
                        marginTop: "4px",
                      }}
                    >
                      To send your own link to this person, create a new invite.
                      Only the invite creator or a project owner can copy this
                      link.
                    </div>
                  )}
                </div>
                <Space size={6} wrap>
                  <Popconfirm
                    title="Revoke this pending invitation?"
                    description={
                      invite.invite_source === "email"
                        ? "The invite link will stop working."
                        : "The invitee will no longer be able to accept this invitation."
                    }
                    okText="Revoke"
                    cancelText="Cancel"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void respond(invite.invite_id, "revoke")}
                  >
                    <Button
                      danger
                      size="small"
                      loading={busy === `${invite.invite_id}:revoke`}
                    >
                      Revoke
                    </Button>
                  </Popconfirm>
                  {canCopyEmailLink && (
                    <Button
                      size="small"
                      loading={busy === `${invite.invite_id}:copy`}
                      onClick={() => void copyInviteLink(invite.invite_id)}
                    >
                      <Icon name="copy" /> Copy Link
                    </Button>
                  )}
                </Space>
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
                    Blocked <TimeAgo date={block.created} />
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
    ? "Track pending invitations for this project. Any collaborator can revoke stale or mistaken invites; only the creator or a project owner can copy an email invite link."
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

  if (projectMode && !isExpanded && !error) {
    return (
      <div
        style={{
          alignItems: "center",
          background: "white",
          border: `1px solid ${COLORS.GRAY_LL}`,
          borderRadius: 10,
          display: "flex",
          gap: 12,
          justifyContent: "space-between",
          padding: "8px 12px",
        }}
      >
        <Button
          type="text"
          size="small"
          onClick={() => set_expanded(true)}
          style={{ fontWeight: 600, height: "auto", paddingInline: 0 }}
        >
          <Icon name="caret-right" /> <Icon name="mail" /> Pending invitations
        </Button>
        <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
          <Tag color="purple" style={{ marginInlineEnd: 0 }}>
            {outgoing.length} pending
          </Tag>
          <Button
            type="text"
            size="small"
            onClick={() => void load()}
            disabled={loading}
            style={{ paddingInline: 4 }}
          >
            <Icon name="refresh" />
          </Button>
        </div>
      </div>
    );
  }

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
