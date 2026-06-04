/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Collapse, CollapseProps, Space, Typography } from "antd";
import { useEffect, useState } from "react";

import { Icon, Title } from "@cocalc/frontend/components";
import { RegistrationToken } from "./registration-token";
import { MembershipTiers } from "./membership-tiers";
import SiteSettings from "./site-settings";
import { UserSearch } from "./users/user-search";
import { SoftwareLicensesAdmin } from "./software-licenses";
import { RootfsAdmin } from "./rootfs";
import { NewsAdminPage } from "./news/page";
import { BayOpsAdmin } from "./bay-ops";
import { ManagedEgressAdminOverview } from "./managed-egress-overview";
import { ManagedCpuAdminOverview } from "./managed-cpu-overview";
import { ProjectBackupShardsAdmin } from "./project-backup-shards";
import { SsoAdmin } from "./sso";
import { SiteSetupAdmin, SiteSetupBanner } from "./site-setup";
import { SiteLicensesAdmin } from "./site-licenses";
import { AdminPurchaseAdmin } from "./admin-purchase";
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
  const routeSection = route.kind === "index" ? route.section : undefined;
  const pageActions = useActions("page");
  const [activeKey, setActiveKey] = useState<string[]>(
    routeSection ? [routeSection] : [],
  );

  useEffect(() => {
    if (routeSection) {
      setActiveKey((activeKey) =>
        activeKey.includes(routeSection)
          ? activeKey
          : [...activeKey, routeSection],
      );
    }
  }, [routeSection]);

  if (route.kind !== "index") {
    return <NewsAdminPage route={route} />;
  }

  const openSetup = () => {
    setActiveKey((activeKey) =>
      activeKey.includes("site-setup")
        ? activeKey
        : ["site-setup", ...activeKey],
    );
    pageActions.set_active_tab("admin", false);
    pageActions.setState({
      admin_route: { kind: "index", section: "site-setup" },
    });
    set_url_with_search(
      getAdminUrlPath({ kind: "index", section: "site-setup" }),
      "",
    );
  };

  if (routeSection === "site-setup") {
    return (
      <div
        className="smc-vfill"
        style={{
          overflowY: "auto",
          overflowX: "hidden",
          padding: "30px 45px",
        }}
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Space wrap>
            <Button href="/admin">Back to all admin settings</Button>
          </Space>
          <SiteSetupAdmin />
        </Space>
      </div>
    );
  }

  const items: CollapseProps["items"] = [
    {
      key: "site-setup",
      label: (
        <div style={headerStyle}>
          <Icon name="check-square" style={{ marginRight: "8px" }} /> Site Setup
        </div>
      ),
      children: <SiteSetupAdmin />,
    },
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
      key: "managed-cpu",
      label: (
        <div style={headerStyle}>
          <Icon name="line-chart" style={{ marginRight: "8px" }} /> CPU & Abuse
          Signals
        </div>
      ),
      children: <ManagedCpuAdminOverview />,
    },
    {
      key: "managed-egress",
      label: (
        <div style={headerStyle}>
          <Icon name="exchange" style={{ marginRight: "8px" }} /> Network Egress
        </div>
      ),
      children: <ManagedEgressAdminOverview />,
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
      key: "bay-ops",
      label: (
        <div style={headerStyle}>
          <Icon name="server" style={{ marginRight: "8px" }} /> Bay Operations
        </div>
      ),
      children: <BayOpsAdmin />,
    },
    {
      key: "project-backup-shards",
      label: (
        <div style={headerStyle}>
          <Icon name="database" style={{ marginRight: "8px" }} /> Backup Shards
        </div>
      ),
      children: <ProjectBackupShardsAdmin />,
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
      key: "sso",
      label: (
        <div style={headerStyle}>
          <Icon name="sign-in" style={{ marginRight: "8px" }} /> SSO Providers &
          Domains
        </div>
      ),
      children: <SsoAdmin />,
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
    {
      key: "admin-purchase",
      label: (
        <div style={headerStyle}>
          <Icon name="shopping-cart" style={{ marginRight: "8px" }} /> Admin
          Purchase
        </div>
      ),
      children: <AdminPurchaseAdmin />,
    },
    {
      key: "site-licenses",
      label: (
        <div style={headerStyle}>
          <Icon name="users" style={{ marginRight: "8px" }} /> Site Licenses
        </div>
      ),
      children: <SiteLicensesAdmin />,
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
      <SiteSetupBanner onOpenSetup={openSetup} />
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
