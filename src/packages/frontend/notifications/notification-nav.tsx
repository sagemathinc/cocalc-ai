/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Menu } from "antd";
import React from "react";
import { useIntl } from "react-intl";

import { Icon, IconName, MenuItems, Text } from "@cocalc/frontend/components";
import { NotificationFilter } from "./mentions/types";
import { MSGS } from "./notification-i18n";

interface Props {
  filter: NotificationFilter;
  on_click: (label: NotificationFilter) => void;
  unread_count: number;
  news_unread: number;
  style: React.CSSProperties;
}

export function NotificationNav({
  filter,
  on_click,
  unread_count,
  news_unread,
  style,
}: Props) {
  const intl = useIntl();

  const ITEMS: MenuItems = [
    {
      key: "unread",
      label: (
        <Text strong style={{ fontSize: "125%", textOverflow: "ellipsis" }}>
          <Icon name="eye-slash" /> {intl.formatMessage(MSGS.unread)} (
          {unread_count})
        </Text>
      ),
    },
    {
      key: "read",
      label: (
        <Text strong style={{ fontSize: "125%", textOverflow: "ellipsis" }}>
          <Icon name="eye" /> {intl.formatMessage(MSGS.read)}
        </Text>
      ),
    },
    {
      key: "allNews",
      label: (
        <Text strong style={{ fontSize: "125%", textOverflow: "ellipsis" }}>
          <Icon name={"mail" as IconName} /> {intl.formatMessage(MSGS.news)} (
          {news_unread})
        </Text>
      ),
    },
  ];

  return (
    <Menu
      onClick={(e) => on_click(e.key as NotificationFilter)}
      style={style}
      selectedKeys={[filter]}
      mode="inline"
      items={ITEMS}
    />
  );
}
