/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button } from "antd";

import { A } from "@cocalc/frontend/components";
import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { CSS, redux, useState } from "@cocalc/frontend/app-framework";
import { Icon, IconName, TimeAgo } from "@cocalc/frontend/components";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import Fragment from "@cocalc/frontend/misc/fragment-id";
import { ProjectTitle } from "@cocalc/frontend/projects/project-title";
import { User } from "@cocalc/frontend/users";
import { COLORS } from "@cocalc/util/theme";
import { NotificationFilter, MentionInfo } from "./types";

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
  user_map: any;
  filter: NotificationFilter;
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
  const { id, mention, user_map, filter } = props;
  const {
    kind,
    path,
    project_id,
    source,
    time,
    target,
    description,
    fragment_id,
    title,
    body_markdown,
    origin_label,
    action_link,
    action_label,
    severity,
  } = mention.toJS();

  const [clicked, setClicked] = useState(false);

  const fragmentId = Fragment.decode(fragment_id);
  const is_read = mention.getIn(["users", target, "read"]);

  const clickedStyle: CSS =
    clicked && (filter === "unread" || filter === "read")
      ? { backgroundColor: COLORS.GRAY_LL }
      : {};

  const row_style: CSS =
    is_read && !clicked
      ? { color: "rgb(88, 96, 105)", ...clickedStyle }
      : { ...clickedStyle };

  function markReadState(how: "read" | "unread") {
    if (filter === "unread" || filter === "read") {
      setClicked(true);
      setTimeout(() => {
        setClicked(false);
        redux.getActions("mentions")?.mark(mention, id, how);
      }, 1000);
    } else {
      redux.getActions("mentions")?.mark(mention, id, how);
    }
  }

  function on_read_unread_click(e) {
    e.preventDefault();
    e.stopPropagation();
    markReadState(is_read ? "unread" : "read");
  }

  function clickMentionRow(): void {
    redux.getProjectActions(project_id).open_file({
      path,
      chat: !!fragmentId?.chat,
      fragmentId,
    });
    markReadState("read");
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
            markReadState("read");
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
            {origin_label ?? "System"} <TimeAgo date={time.getTime()} />
          </div>
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

  const onClick =
    kind === "mention" && project_id
      ? clickMentionRow
      : () => markReadState("read");

  return (
    <li
      className="cocalc-notification-row-entry"
      onClick={onClick}
      style={row_style}
    >
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
        <Button type="text" ghost={true} onClick={on_read_unread_click}>
          <Icon name={is_read ? "square" : "check-square"} />{" "}
          {is_read ? "Mark Unread" : "Mark Read"}
        </Button>
      </div>
    </li>
  );
}
