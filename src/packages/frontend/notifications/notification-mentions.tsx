/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Collapse, Space } from "antd";
const { Panel } = Collapse;
import { CSS, redux } from "@cocalc/frontend/app-framework";
import { Icon, Loading, MarkAll } from "@cocalc/frontend/components";
import { ProjectTitle } from "@cocalc/frontend/projects/project-title";
import { unreachable } from "@cocalc/util/misc";
import {
  MentionsFilter,
  MentionsMap,
  NotificationFilter,
} from "./mentions/types";
import { isNewsFilter } from "./news/types";
import { NoMentions } from "./notification-no-mentions";
import { NotificationRow } from "./mentions/notification-row";

interface MentionsPanelProps {
  filter: MentionsFilter;
  loading?: boolean;
  mentions: MentionsMap;
  user_map;
  account_id: string;
  style: CSS;
}

export function MentionsPanel(props: MentionsPanelProps) {
  const { filter, loading, mentions, user_map, account_id, style } = props;
  const mentions_actions = redux.getActions("mentions");

  if (isNewsFilter(filter)) {
    throw Error("Should be in NewsPanel");
  }

  if (loading) {
    return <Loading theme="medium" />;
  }

  if (!isNewsFilter(filter) && (mentions == undefined || mentions.size == 0)) {
    return <NoMentions filter={filter} style={style} />;
  }

  function markRead(project_id: string | null, filter: "read" | "unread") {
    mentions_actions.markAll(project_id, filter);
  }

  function renderMarkAll(project_id: string | null) {
    if (isNewsFilter(filter)) return null;

    const opposite: NotificationFilter = filter === "read" ? "unread" : "read";
    return (
      <Space orientation="horizontal" size="small">
        <MarkAll
          how={opposite}
          size="small"
          onClick={(how: "read" | "unread") => markRead(project_id, how)}
        />
      </Space>
    );
  }

  // TODO this is old code, should be refactored

  const mentions_per_project: any = {};
  const project_panels: any = [];
  const project_id_order: Array<string | null> = [];

  mentions
    .filter((m) => m.get("target") === account_id)
    .filter((m) => {
      const status = m.getIn(["users", account_id])?.toJS() ?? {
        read: false,
        saved: false,
      };

      switch (filter) {
        case "unread":
          return status.read === false;
        case "read":
          return status.read === true;
        default:
          unreachable(filter);
      }
    })
    .map((m, id) => {
      const path = m.get("path");
      const time = m.get("time");
      const project_id = m.get("project_id") ?? null;
      const project_key = project_id ?? "__general__";
      if (mentions_per_project[project_key] == undefined) {
        mentions_per_project[project_key] = [];
        project_id_order.push(project_id);
      }
      mentions_per_project[project_key].push(
        <NotificationRow
          key={path + time.getTime()}
          id={id}
          mention={m}
          user_map={user_map}
        />,
      );
    });

  // Check if this user has only made mentions and no one has mentioned them
  if (project_id_order.length == 0) {
    return <NoMentions filter={filter} style={style} />;
  }

  for (const project_id of project_id_order) {
    const panel_key = project_id ?? "__general__";
    project_panels.push(
      <Collapse
        defaultActiveKey={project_id_order.map((id) => id ?? "__general__")}
        key={panel_key}
        className="cocalc-notification-list"
      >
        <Panel
          key={panel_key}
          header={
            project_id == null ? (
              <>
                <Icon name="bell" style={{ marginRight: "10px" }} />
                General Notifications
              </>
            ) : (
              <ProjectTitle project_id={project_id} />
            )
          }
          extra={renderMarkAll(project_id)}
        >
          <ul>{mentions_per_project[panel_key]}</ul>
        </Panel>
      </Collapse>,
    );
  }

  return (
    <Space orientation="vertical" size="large">
      {project_panels}
    </Space>
  );
}
