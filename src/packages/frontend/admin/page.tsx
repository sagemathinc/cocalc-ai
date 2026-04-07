/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Collapse, CollapseProps, Space, Typography } from "antd";
import { useState } from "react";

import { Icon, Title } from "@cocalc/frontend/components";
import { RegistrationToken } from "./registration-token";
import { MembershipTiers } from "./membership-tiers";
import SiteSettings from "./site-settings";
import { UserSearch } from "./users/user-search";
import AIAvatar from "@cocalc/frontend/components/ai-avatar";
import { TestLLMAdmin } from "./llm/admin-llm-test";
import { SoftwareLicensesAdmin } from "./software-licenses";
import { RootfsAdmin } from "./rootfs";
import { NewsAdminPage } from "./news/page";
import {
  getAdminUrlPath,
  normalizeAdminRoute,
  type AdminRoute,
} from "./routing";
import { useActions } from "@cocalc/frontend/app-framework";
import { set_url_with_search } from "@cocalc/frontend/history";

const headerStyle = { fontSize: "12pt" } as const;
const { Paragraph, Text } = Typography;

export function AdminPage({
  route = { kind: "index" },
}: {
  route?: AdminRoute;
}) {
  route = normalizeAdminRoute(route);
  const pageActions = useActions("page");
  const [activeKey, setActiveKey] = useState<string[]>([]);

  if (route.kind !== "index") {
    return <NewsAdminPage route={route} />;
  }

  const items: CollapseProps["items"] = [
    {
      key: "user-search",
      label: (
        <div style={headerStyle}>
          <Icon name="users" style={{ marginRight: "8px" }} /> User Search
        </div>
      ),
      children: <UserSearch />,
    },
    {
      key: "news",
      label: (
        <div style={headerStyle}>
          <Icon name="file-alt" style={{ marginRight: "8px" }} /> News
        </div>
      ),
      children: (
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <Paragraph style={{ marginBottom: 0 }}>
            Create and edit public news items and events in the app with the new
            markdown editor, image paste/upload support, and live preview.
          </Paragraph>
          <Space wrap>
            <Button
              type="primary"
              onClick={() => {
                pageActions.set_active_tab("admin", false);
                pageActions.setState({
                  admin_route: { kind: "news-list" },
                });
                set_url_with_search(getAdminUrlPath({ kind: "news-list" }), "");
              }}
            >
              Open news manager
            </Button>
            <Button
              onClick={() => {
                pageActions.set_active_tab("admin", false);
                pageActions.setState({
                  admin_route: { kind: "news-editor", id: "new" },
                });
                set_url_with_search(
                  getAdminUrlPath({ kind: "news-editor", id: "new" }),
                  "",
                );
              }}
            >
              Create news item
            </Button>
            <Button
              onClick={() => {
                pageActions.set_active_tab("admin", false);
                pageActions.setState({
                  admin_route: { kind: "news-editor", id: "new" },
                });
                set_url_with_search(
                  getAdminUrlPath({ kind: "news-editor", id: "new" }),
                  "?channel=event",
                );
              }}
            >
              Create event
            </Button>
            <Button
              onClick={() => {
                pageActions.set_active_tab("admin", false);
                pageActions.setState({
                  admin_route: { kind: "news-editor", id: "new" },
                });
                set_url_with_search(
                  getAdminUrlPath({ kind: "news-editor", id: "new" }),
                  "?channel=system",
                );
              }}
            >
              Create system notice
            </Button>
          </Space>
          <Text type="secondary">
            Legacy <Text code>/news/edit/*</Text> links now redirect into this
            admin flow.
          </Text>
        </Space>
      ),
    },
    {
      key: "site-settings",
      label: (
        <div style={headerStyle}>
          <Icon name="gears" style={{ marginRight: "8px" }} /> Site Settings
        </div>
      ),
      children: (
        <SiteSettings
          close={() => {
            setActiveKey(activeKey.filter((key) => key != "site-settings"));
          }}
        />
      ),
    },
    {
      key: "rootfs",
      label: (
        <div style={headerStyle}>
          <Icon name="database" style={{ marginRight: "8px" }} /> RootFS Images
        </div>
      ),
      children: <RootfsAdmin />,
    },
    {
      key: "software-licenses",
      label: (
        <div style={headerStyle}>
          <Icon name="key" style={{ marginRight: "8px" }} /> Software Licenses
        </div>
      ),
      children: <SoftwareLicensesAdmin />,
    },
    {
      key: "registration-tokens",
      label: (
        <div style={headerStyle}>
          <Icon name="sign-in" style={{ marginRight: "8px" }} /> Registration
          Tokens
        </div>
      ),
      children: <RegistrationToken />,
    },
    {
      key: "membership-tiers",
      label: (
        <div style={headerStyle}>
          <Icon name="user" style={{ marginRight: "8px" }} /> Membership Tiers
        </div>
      ),
      children: <MembershipTiers />,
    },
    //     {
    //       key: "usage-stats",
    //       label: (
    //         <div style={headerStyle}>
    //           <Icon name="line-chart" style={{ marginRight: "8px" }} /> Usage
    //           Statistics
    //         </div>
    //       ),
    //       children: <UsageStatistics />,
    //     },
    {
      key: "llm-testing",
      label: (
        <div style={headerStyle}>
          <AIAvatar size={16} style={{ marginRight: "8px" }} /> Test LLM
          Integration
        </div>
      ),
      children: <TestLLMAdmin />,
    },
  ];

  return (
    <div
      className="smc-vfill"
      style={{
        overflowY: "auto",
        overflowX: "hidden",
        padding: "30px 45px",
      }}
    >
      <Title level={3}>Administration</Title>
      <Collapse
        destroyOnHidden /* so that data is refreshed when they are shown */
        activeKey={activeKey}
        onChange={(activeKey) => {
          setActiveKey(activeKey as string[]);
        }}
        items={items}
      />
    </div>
  );
}
