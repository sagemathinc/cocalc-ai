/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Tag } from "antd";

import { A } from "@cocalc/frontend/components";
import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { CSS, redux } from "@cocalc/frontend/app-framework";
import { Icon, IconName, TimeAgo } from "@cocalc/frontend/components";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { ProjectTitle } from "@cocalc/frontend/projects/project-title";
import { User } from "@cocalc/frontend/users";
import { MentionInfo } from "./types";

const DESCRIPTION_STYLE: CSS = {
  flex: "1 1 auto",
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
    project_id,
    source,
    time,
    target,
    description,
    title,
    body_markdown,
    origin_label,
    action_link,
    action_label,
    severity,
  } = mention.toJS();
  const is_read = mention.getIn(["users", target, "read"]);

  const row_style: CSS = is_read ? { color: "rgb(88, 96, 105)" } : {};
  const count = groupCount ?? groupedIds?.length ?? 1;
  const groupIds =
    groupedIds != null && groupedIds.length > 0 ? groupedIds : [id];

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

  function renderActionLink() {
    if (!action_link) {
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
              style={{ color: "rgb(100, 100, 100)", margin: "4px 10px" }}
              value={body_markdown}
            />
          ) : null}
          {renderActionLink()}
        </>
      );
    }

    return (
      <>
        <strong>
          <User account_id={source} user_map={user_map} />
        </strong>{" "}
        mentioned you in the file <code>{path}</code> in the project{" "}
        <ProjectTitle project_id={project_id} />.
        {description ? (
          <StaticMarkdown
            style={{ color: "rgb(100, 100, 100)", margin: "4px 10px" }}
            value={description}
          />
        ) : (
          <br />
        )}
        <Icon name={"comment"} /> <TimeAgo date={time.getTime()} />
      </>
    );
  }

  return (
    <li className="cocalc-notification-row-entry" style={row_style}>
      <div style={AVATAR_WRAPPING_STYLE}>
        {kind === "mention" && source ? (
          <Avatar account_id={source} />
        ) : (
          <Icon
            name={severityIcon(severity)}
            style={{ fontSize: "24px", color: "rgb(100, 100, 100)" }}
          />
        )}
      </div>
      <div style={DESCRIPTION_STYLE}>{renderBody()}</div>
      <div style={ACTION_ICONS_WRAPPING_STYLE}>
        <Button type="text" onClick={on_read_unread_click}>
          <Icon name={is_read ? "square" : "check-square"} />{" "}
          {is_read ? "Mark Unread" : "Mark Read"}
        </Button>
      </div>
    </li>
  );
}
