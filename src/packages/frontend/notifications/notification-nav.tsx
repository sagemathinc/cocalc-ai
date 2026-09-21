/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Menu, Tabs } from "antd";
import React from "react";
import { useIntl } from "react-intl";

import { Icon, IconName, MenuItems, Text } from "@cocalc/frontend/components";
import { NotificationFilter } from "./mentions/types";
import { MSGS } from "./notification-i18n";

interface Props {
  filter: NotificationFilter;
  on_click: (label: NotificationFilter) => void;
  unread_count: number;
  attention_count: number;
  news_unread: number;
  style: React.CSSProperties;
  horizontal?: boolean;
}

export function NotificationNav({
  filter,
  on_click,
  unread_count,
  attention_count,
  news_unread,
  style,
  horizontal = false,
}: Props) {
  const intl = useIntl();

  if (horizontal) {
    return (
      <Tabs
        aria-label="Notification filters"
        activeKey={filter}
        onChange={(key) => on_click(key as NotificationFilter)}
        size="small"
        tabBarGutter={16}
        style={style}
        items={[
          { key: "attention", label: `Attention (${attention_count})` },
          {
            key: "unread",
            label: `${intl.formatMessage(MSGS.unread)} (${unread_count})`,
          },
          { key: "read", label: intl.formatMessage(MSGS.read) },
          {
            key: "allNews",
            label: `${intl.formatMessage(MSGS.news)} (${news_unread})`,
          },
        ]}
      />
    );
  }

  const ITEMS: MenuItems = [
    {
      key: "attention",
      label: (
        <Text
          strong
          style={{
            fontSize: "125%",
            textOverflow: "ellipsis",
            color: "inherit",
          }}
        >
          <Icon name="exclamation-circle" /> Needs attention ({attention_count})
        </Text>
      ),
    },
    {
      key: "unread",
      label: (
        <Text
          strong
          style={{
            fontSize: "125%",
            textOverflow: "ellipsis",
            color: "inherit",
          }}
        >
          <Icon name="eye-slash" /> {intl.formatMessage(MSGS.unread)} (
          {unread_count})
        </Text>
      ),
    },
    {
      key: "read",
      label: (
        <Text
          strong
          style={{
            fontSize: "125%",
            textOverflow: "ellipsis",
            color: "inherit",
          }}
        >
          <Icon name="eye" /> {intl.formatMessage(MSGS.read)}
        </Text>
      ),
    },
    {
      key: "allNews",
      label: (
        <Text
          strong
          style={{
            fontSize: "125%",
            textOverflow: "ellipsis",
            color: "inherit",
          }}
        >
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
