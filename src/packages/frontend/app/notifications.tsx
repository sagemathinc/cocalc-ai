/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Badge } from "antd";
import {
  CSS,
  React,
  useActions,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { unreachable } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import track from "@cocalc/frontend/user-tracking";
import { PageStyle, TOP_BAR_ELEMENT_CLASS } from "./top-nav-consts";
import { blur_active_element } from "./util";
import { useEffect, useMemo } from "react";
import { set_window_title } from "@cocalc/frontend/browser";

interface Props {
  type: "bell" | "notifications";
  active: boolean;
  pageStyle: PageStyle;
}

export const Notification: React.FC<Props> = React.memo((props: Props) => {
  const { active, type, pageStyle } = props;
  const { topPaddingIcons, sidePaddingIcons, fontSizeIcons } = pageStyle;
  const page_actions = useActions("page");

  const mentions_unread = useTypedRedux("mentions", "unread_count") ?? 0;
  const notify_count = useTypedRedux("file_use", "notify_count");
  const news_unread = useTypedRedux("news", "unread");

  const count = useMemo(() => {
    switch (type) {
      case "bell":
        return notify_count ?? 0;
      case "notifications":
        return mentions_unread + (news_unread ?? 0);
      default:
        unreachable(type);
        return 0;
    }
  }, [type, notify_count, mentions_unread, news_unread]);

  useEffect(() => {
    set_window_title();
  }, [count, news_unread]);

  const outer_style: CSS = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    padding: `${topPaddingIcons} ${sidePaddingIcons}`,
    height: `${pageStyle.height}px`,
    ...(active ? { backgroundColor: COLORS.TOP_BAR.ACTIVE } : {}),
  };

  const inner_style: CSS = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 0,
  };

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();

    switch (type) {
      case "bell":
        page_actions.toggle_show_file_use();
        blur_active_element();
        if (!active) {
          track("top_nav", { name: "file_use" });
        }
        break;

      case "notifications":
        page_actions.set_active_tab("notifications");
        if (!active) {
          track("top_nav", { name: "mentions" });
        }
        break;

      default:
        unreachable(type);
    }
  }

  function renderBadge() {
    switch (type) {
      case "bell":
        return (
          <Badge
            showZero
            color={count == 0 ? COLORS.GRAY : undefined}
            count={count}
          >
            <Icon
              style={{ fontSize: fontSizeIcons }}
              className={count > 0 ? "smc-bell-notification" : ""}
              name="bell"
            />
          </Badge>
        );

      case "notifications":
        return (
          <Badge
            color={count == 0 ? COLORS.GRAY : undefined}
            count={count}
            size="small"
            showZero={false}
          >
            <Icon
              style={{ fontSize: fontSizeIcons }}
              className={count > 0 ? "smc-bell-notification" : ""}
              name="mail"
            />{" "}
          </Badge>
        );

      default:
        unreachable(type);
    }
  }

  const className = TOP_BAR_ELEMENT_CLASS + (active ? " active" : "");

  return (
    <div style={outer_style} onClick={onClick} className={className}>
      <div style={inner_style}>{renderBadge()}</div>
    </div>
  );
});
