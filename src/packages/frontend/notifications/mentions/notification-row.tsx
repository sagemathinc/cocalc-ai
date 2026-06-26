/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Modal, Space, Tag } from "antd";
import { useEffect, useState } from "react";

import { A } from "@cocalc/frontend/components";
import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { CSS, redux } from "@cocalc/frontend/app-framework";
import { Icon, IconName, TimeAgo } from "@cocalc/frontend/components";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import Fragment from "@cocalc/frontend/misc/fragment-id";
import { ProjectTitle } from "@cocalc/frontend/projects/project-title";
import { User } from "@cocalc/frontend/users";
import { MentionInfo } from "./types";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { ProjectAccessRequestStatus } from "@cocalc/conat/hub/api/projects";

const DESCRIPTION_STYLE: CSS = {
  flex: "1 1 auto",
  minWidth: 0,
  overflowWrap: "normal",
  wordBreak: "normal",
} as const;

const MARKDOWN_STYLE: CSS = {
  color: "rgb(100, 100, 100)",
  margin: "4px 0",
  overflowWrap: "normal",
  wordBreak: "normal",
  whiteSpace: "normal",
} as const;

const AVATAR_WRAPPING_STYLE: CSS = {
  flex: "0 0 auto",
  margin: "0 .9em",
} as const;

const ACTION_ICONS_WRAPPING_STYLE: CSS = {
  flex: "0 0 auto",
  margin: "auto .9em",
} as const;

interface Props {
  id: string;
  mention: MentionInfo;
  groupedIds?: string[];
  groupCount?: number;
  firstTime?: Date;
  latestTime?: Date;
  user_map: any;
}

function severityIcon(severity?: string): IconName {
  switch (severity) {
    case "error":
      return "exclamation-circle";
    case "warning":
      return "warning";
    default:
      return "info-circle";
  }
}

export function NotificationRow(props: Props) {
  const {
    id,
    mention,
    groupedIds,
    groupCount,
    firstTime,
    latestTime,
    user_map,
  } = props;
  const {
    kind,
    path,
    display_path,
    project_id,
    source,
    time,
    target,
    description,
    fragment_id,
    title,
    body_markdown,
    origin_label,
    notice_type,
    request_id,
    requested_role,
    action_link,
    action_label,
    severity,
  } = mention.toJS();
  const shownPath = display_path || path;
  const fragmentId = Fragment.decode(fragment_id);
  const is_read = mention.getIn(["users", target, "read"]);

  const row_style: CSS = {
    ...(is_read ? { color: "rgb(88, 96, 105)" } : {}),
    ...(IS_MOBILE
      ? {
          alignItems: "flex-start",
          display: "grid",
          gridTemplateColumns: "40px minmax(0, 1fr) 36px",
          gap: "8px",
          padding: "10px 4px",
          width: "100%",
        }
      : undefined),
  };
  const count = groupCount ?? groupedIds?.length ?? 1;
  const groupIds =
    groupedIds != null && groupedIds.length > 0 ? groupedIds : [id];
  const [accessRequestAction, setAccessRequestAction] = useState<string | null>(
    null,
  );
  const [accessRequestStatus, setAccessRequestStatus] = useState<string | null>(
    null,
  );
  const [accessRequestError, setAccessRequestError] = useState<string | null>(
    null,
  );
  const [accessRequestCurrentStatus, setAccessRequestCurrentStatus] =
    useState<ProjectAccessRequestStatus | null>(null);
  const [checkingAccessRequestStatus, setCheckingAccessRequestStatus] =
    useState<boolean>(false);
  const isProjectAccessRequestNotice =
    kind === "account_notice" &&
    notice_type === "project_access_request" &&
    !!project_id &&
    !!request_id &&
    (requested_role === "viewer" || requested_role === "collaborator");

  function markReadState(how: "read" | "unread") {
    if (groupIds.length > 1) {
      redux.getActions("mentions")?.markMany(groupIds, how);
      return;
    }
    redux.getActions("mentions")?.mark(mention, id, how);
  }

  function on_read_unread_click(e) {
    e.preventDefault();
    e.stopPropagation();
    markReadState(is_read ? "unread" : "read");
  }

  function clickNotificationTarget(): void {
    if (!project_id || !path) return;
    redux.getProjectActions(project_id).open_file({
      path,
      chat: !!fragmentId?.chat,
      fragmentId,
    });
    markReadState("read");
  }

  function renderActionLink() {
    if (!action_link || isProjectAccessRequestNotice) {
      return null;
    }
    return (
      <>
        <br />
        <A
          href={action_link}
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          {action_label ?? "Open"}
        </A>
      </>
    );
  }

  useEffect(() => {
    if (!isProjectAccessRequestNotice || !project_id || !request_id) {
      setAccessRequestCurrentStatus(null);
      setCheckingAccessRequestStatus(false);
      return;
    }
    let cancelled = false;
    setCheckingAccessRequestStatus(true);
    setAccessRequestCurrentStatus(null);
    (async () => {
      try {
        const requests =
          await webapp_client.project_collaborators.list_access_requests({
            project_id,
            limit: 1000,
          });
        if (cancelled) return;
        const request = requests.find(
          (request) => request.request_id === request_id,
        );
        setAccessRequestCurrentStatus(request?.status ?? null);
      } catch {
        if (!cancelled) {
          setAccessRequestCurrentStatus(null);
        }
      } finally {
        if (!cancelled) {
          setCheckingAccessRequestStatus(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isProjectAccessRequestNotice, project_id, request_id]);

  async function respondToProjectAccessRequest(
    action: "approve" | "deny" | "block",
    role?: "viewer" | "collaborator",
  ) {
    if (!project_id || !request_id) return;
    const key = `${action}:${role ?? ""}`;
    setAccessRequestAction(key);
    setAccessRequestError(null);
    try {
      await webapp_client.project_collaborators.respond_access_request({
        project_id,
        request_id,
        action,
        role,
      });
      setAccessRequestCurrentStatus(
        action === "approve"
          ? "approved"
          : action === "block"
            ? "blocked"
            : "denied",
      );
      setAccessRequestStatus(
        action === "approve"
          ? `Approved ${role ?? requested_role} access.`
          : action === "block"
            ? "Denied and blocked future requests from this user."
            : "Denied this access request.",
      );
      markReadState("read");
    } catch (err) {
      setAccessRequestError(`${err}`);
    } finally {
      setAccessRequestAction(null);
    }
  }

  function renderProjectAccessRequestActions() {
    if (!isProjectAccessRequestNotice) {
      return null;
    }
    if (accessRequestStatus != null) {
      return (
        <Alert
          showIcon
          type="success"
          title={accessRequestStatus}
          style={{ marginTop: 8 }}
        />
      );
    }
    if (
      accessRequestCurrentStatus != null &&
      accessRequestCurrentStatus !== "pending"
    ) {
      const statusLabel =
        accessRequestCurrentStatus === "approved"
          ? "approved"
          : accessRequestCurrentStatus === "blocked"
            ? "blocked"
            : accessRequestCurrentStatus === "canceled"
              ? "canceled"
              : "denied";
      return (
        <Alert
          showIcon
          type={accessRequestCurrentStatus === "approved" ? "success" : "info"}
          title={`Access request already ${statusLabel}.`}
          description="This request has already been resolved."
          style={{ marginTop: 8 }}
        />
      );
    }
    if (checkingAccessRequestStatus) {
      return (
        <Alert
          showIcon
          type="info"
          title="Checking access request status..."
          style={{ marginTop: 8 }}
        />
      );
    }
    return (
      <Space
        wrap
        size={[8, 8]}
        style={{ marginTop: 8 }}
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          type="primary"
          size="small"
          loading={accessRequestAction === `approve:${requested_role}`}
          onClick={() =>
            void respondToProjectAccessRequest("approve", requested_role)
          }
        >
          Approve {requested_role}
        </Button>
        {requested_role === "collaborator" ? (
          <Button
            size="small"
            loading={accessRequestAction === "approve:viewer"}
            onClick={() =>
              void respondToProjectAccessRequest("approve", "viewer")
            }
          >
            Approve viewer
          </Button>
        ) : null}
        <Button
          size="small"
          loading={accessRequestAction === "deny:"}
          onClick={() => void respondToProjectAccessRequest("deny")}
        >
          Deny
        </Button>
        <Button
          danger
          size="small"
          loading={accessRequestAction === "block:"}
          onClick={() => {
            Modal.confirm({
              title: "Block access requests from this user?",
              content:
                "This denies the current request and prevents this account from requesting access to this project again.",
              okText: "Block",
              okButtonProps: { danger: true },
              onOk: () => respondToProjectAccessRequest("block"),
            });
          }}
        >
          Block
        </Button>
        {accessRequestError != null ? (
          <Alert
            showIcon
            type="error"
            title="Unable to review access request"
            description={accessRequestError}
            style={{ width: "100%" }}
          />
        ) : null}
      </Space>
    );
  }

  function renderBody() {
    if (kind === "account_notice") {
      return (
        <>
          <strong>{title ?? "Notification"}</strong>
          <div style={{ color: "rgb(100, 100, 100)" }}>
            {origin_label ?? "System"}{" "}
            <TimeAgo date={(latestTime ?? time).getTime()} />
            {count > 1 ? (
              <Tag style={{ marginLeft: 8 }}>{count} times</Tag>
            ) : null}
          </div>
          {count > 1 ? (
            <div style={{ color: "rgb(100, 100, 100)", marginTop: 2 }}>
              Received from <TimeAgo date={(firstTime ?? time).getTime()} /> to{" "}
              <TimeAgo date={(latestTime ?? time).getTime()} />.
            </div>
          ) : null}
          {body_markdown ? (
            <StaticMarkdown
              style={{
                ...MARKDOWN_STYLE,
                margin: IS_MOBILE ? "4px 0" : "4px 10px",
              }}
              value={body_markdown}
            />
          ) : null}
          {renderProjectAccessRequestActions()}
          {renderActionLink()}
        </>
      );
    }

    return (
      <>
        <strong>
          <User account_id={source} user_map={user_map} />
        </strong>{" "}
        mentioned you in the file <code>{shownPath}</code> in the project{" "}
        <ProjectTitle project_id={project_id} />.
        {description ? (
          <StaticMarkdown
            style={{
              ...MARKDOWN_STYLE,
              margin: IS_MOBILE ? "4px 0" : "4px 10px",
            }}
            value={description}
          />
        ) : (
          <br />
        )}
        <Icon name={"comment"} /> <TimeAgo date={time.getTime()} />
      </>
    );
  }

  const onClick = project_id && path ? clickNotificationTarget : undefined;

  return (
    <li
      className="cocalc-notification-row-entry"
      onClick={onClick}
      style={row_style}
    >
      <div
        style={
          IS_MOBILE
            ? { ...AVATAR_WRAPPING_STYLE, margin: "0", textAlign: "center" }
            : AVATAR_WRAPPING_STYLE
        }
      >
        {kind === "mention" && source ? (
          <Avatar account_id={source} />
        ) : (
          <Icon
            name={severityIcon(severity)}
            style={{ fontSize: "24px", color: "rgb(100, 100, 100)" }}
          />
        )}
      </div>
      <div
        className="cocalc-notification-row-message"
        style={DESCRIPTION_STYLE}
      >
        {renderBody()}
      </div>
      <div
        style={
          IS_MOBILE
            ? { ...ACTION_ICONS_WRAPPING_STYLE, margin: "0" }
            : ACTION_ICONS_WRAPPING_STYLE
        }
      >
        <Button
          type="text"
          onClick={on_read_unread_click}
          aria-label={is_read ? "Mark Unread" : "Mark Read"}
          style={IS_MOBILE ? { padding: 0 } : undefined}
        >
          <Icon name={is_read ? "square" : "check-square"} />{" "}
          {!IS_MOBILE && (is_read ? "Mark Unread" : "Mark Read")}
        </Button>
      </div>
    </li>
  );
}
