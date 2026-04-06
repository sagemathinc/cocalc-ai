/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Menu } from "antd";
import React from "react";
import { defineMessage, useIntl } from "react-intl";

import { Icon, IconName, MenuItems, Text } from "@cocalc/frontend/components";
import { IntlMessage } from "@cocalc/frontend/i18n";
import { Channel, CHANNELS, CHANNELS_ICONS } from "@cocalc/util/types/news";
import { NotificationFilter } from "./mentions/types";
import { BOOKMARK_ICON_NAME } from "./mentions/util";
import { MSGS } from "./notification-i18n";

const CHANNELS_NAMES: { [name in Channel]: IntlMessage } = {
  announcement: defineMessage({
    id: "news.nav.announcement.name",
    defaultMessage: "Announcement",
  }),
  feature: defineMessage({
    id: "news.nav.feature.name",
    defaultMessage: "Feature",
  }),
  event: defineMessage({ id: "news.nav.event.name", defaultMessage: "Event" }),
  platform: defineMessage({
    id: "news.nav.platform.name",
    defaultMessage: "Platform",
  }),
  about: defineMessage({ id: "news.nav.about.name", defaultMessage: "About" }),
} as const;

interface Props {
  filter: NotificationFilter;
  on_click: (label: NotificationFilter) => void;
  style: React.CSSProperties;
}

export function NotificationNav({ filter, on_click, style }: Props) {
  const intl = useIntl();

  const ITEMS: MenuItems = [
    {
      key: "mentions",
      label: (
        <Text strong style={{ fontSize: "125%" }}>
          {intl.formatMessage(MSGS.mentions)}
        </Text>
      ),
      children: [
        {
          key: "unread",
          label: (
            <span style={{ textOverflow: "ellipsis", overflow: "hidden" }}>
              <Icon name="eye-slash" /> {intl.formatMessage(MSGS.unread)}
            </span>
          ),
        },
        {
          key: "read",
          label: (
            <span style={{ textOverflow: "ellipsis", overflow: "hidden" }}>
              <Icon name="eye" /> {intl.formatMessage(MSGS.read)}
            </span>
          ),
        },
        {
          key: "saved",
          label: (
            <span style={{ textOverflow: "ellipsis", overflow: "hidden" }}>
              <Icon name={BOOKMARK_ICON_NAME} />{" "}
              {intl.formatMessage(MSGS.saved)}
            </span>
          ),
        },
        {
          key: "all",
          label: (
            <span style={{ textOverflow: "ellipsis", overflow: "hidden" }}>
              @ {intl.formatMessage(MSGS.all)}
            </span>
          ),
        },
      ],
      type: "group",
    },
    { key: "divider-before-news", type: "divider" },
    {
      key: "news",
      label: (
        <Text strong style={{ fontSize: "125%" }}>
          {intl.formatMessage(MSGS.news)}
        </Text>
      ),
      children: [
        {
          key: "allNews",
          label: (
            <span style={{ textOverflow: "ellipsis", overflow: "hidden" }}>
              <Text strong>
                <Icon name="mail" /> {intl.formatMessage(MSGS.allNews)}
              </Text>
            </span>
          ),
        },
        ...CHANNELS.filter((c) => c !== "event").map((c) => ({
          key: c,
          label: (
            <span style={{ textOverflow: "ellipsis", overflow: "hidden" }}>
              <Icon name={CHANNELS_ICONS[c] as IconName} />{" "}
              {intl.formatMessage(CHANNELS_NAMES[c])}
            </span>
          ),
        })),
      ],
      type: "group",
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
