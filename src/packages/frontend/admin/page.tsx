/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Button,
  Card,
  Flex,
  Grid,
  Menu,
  Select,
  Typography,
  type MenuProps,
} from "antd";
import { useState, type ReactNode } from "react";

import { useActions } from "@cocalc/frontend/app-framework";
import { Icon, Title, type IconName } from "@cocalc/frontend/components";
import { cocalc_setup_profile } from "@cocalc/frontend/components/constants";
import { set_url_with_search } from "@cocalc/frontend/history";
import { COLORS } from "@cocalc/util/theme";
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
import { UsageStatistics } from "./stats/page";
import {
  getAdminUrlPath,
  normalizeAdminRoute,
  type AdminRoute,
  type AdminSection,
} from "./routing";

const { Text } = Typography;
const { useBreakpoint } = Grid;
const IS_STAR_SETUP_PROFILE = cocalc_setup_profile === "star";
const NEWS_MENU_KEY = "news";
const OVERVIEW_MENU_KEY = "overview";
const STAR_HIDDEN_ADMIN_SECTIONS = new Set<string>([
  "managed-cpu",
  "managed-egress",
  "bay-ops",
  "project-backup-shards",
  "software-licenses",
  "sso",
  "admin-purchase",
  "site-licenses",
]);

type AdminMenuKey =
  | AdminSection
  | typeof NEWS_MENU_KEY
  | typeof OVERVIEW_MENU_KEY;

interface AdminSectionDefinition {
  component: () => ReactNode;
  description: string;
  group: AdminGroupKey;
  icon: IconName;
  key: AdminSection;
  title: string;
}

interface AdminNavigationItem {
  description: string;
  group: AdminGroupKey;
  icon: IconName;
  key: AdminMenuKey;
  title: string;
}

type AdminGroupKey =
  | "launch"
  | "operations"
  | "access"
  | "content"
  | "commercial";

const ADMIN_GROUPS: Record<AdminGroupKey, { icon: IconName; title: string }> = {
  launch: { icon: "check-square", title: "Launch Readiness" },
  operations: { icon: "server", title: "Operations" },
  access: { icon: "sign-in", title: "Access & Identity" },
  content: { icon: "file-alt", title: "Content" },
  commercial: { icon: "shopping-cart", title: "Commercial" },
};
const ADMIN_GROUP_KEYS = Object.keys(ADMIN_GROUPS) as AdminGroupKey[];

function isAdminGroupKey(key: string): key is AdminGroupKey {
  return key in ADMIN_GROUPS;
}

export function AdminPage({
  route = { kind: "index" },
}: {
  route?: AdminRoute;
}) {
  route = normalizeAdminRoute(route);
  const screens = useBreakpoint();
  const isMobile = !screens.md;
  const pageActions = useActions("page");
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [openKeys, setOpenKeys] = useState<string[]>(Object.keys(ADMIN_GROUPS));

  function navigate(nextRoute: AdminRoute, search = "") {
    pageActions.set_active_tab("admin", false);
    pageActions.setState({ admin_route: nextRoute });
    set_url_with_search(getAdminUrlPath(nextRoute), search);
  }

  function navigateToSection(section: AdminSection) {
    navigate({ kind: "index", section });
  }

  function openSetup() {
    navigateToSection("site-setup");
  }

  const sections = getAdminSections({
    closeSiteSettings: () => navigate({ kind: "index" }),
  }).filter(
    (section) =>
      !(IS_STAR_SETUP_PROFILE && STAR_HIDDEN_ADMIN_SECTIONS.has(section.key)),
  );
  const sectionByKey = new Map(
    sections.map((section) => [section.key, section]),
  );
  const navigationItems = getNavigationItems(sections);
  const navItemByKey = new Map(navigationItems.map((item) => [item.key, item]));
  const activeMenuKey = getActiveMenuKey(route);
  const activeNavItem = navItemByKey.get(activeMenuKey);
  const title =
    activeMenuKey === OVERVIEW_MENU_KEY
      ? "Administration"
      : (activeNavItem?.title ?? "Administration");

  function renderMenuLabel(icon: IconName, title: string) {
    return (
      <span>
        <Icon name={icon} /> {title}
      </span>
    );
  }

  function renderMenuItems(): MenuProps["items"] {
    if (navCollapsed) {
      return ADMIN_GROUP_KEYS.flatMap((groupKey) => {
        const group = ADMIN_GROUPS[groupKey];
        const groupItem = {
          key: groupKey,
          icon: <Icon name={group.icon} />,
          label: group.title,
        };
        if (!openKeys.includes(groupKey)) {
          return [groupItem];
        }
        return [
          groupItem,
          ...navigationItems
            .filter((item) => item.group === groupKey)
            .map((item) => ({
              key: item.key,
              icon: <Icon name={item.icon} />,
              label: item.title,
            })),
        ];
      });
    }
    return ADMIN_GROUP_KEYS.map((groupKey) => ({
      key: groupKey,
      label: renderMenuLabel(
        ADMIN_GROUPS[groupKey].icon,
        ADMIN_GROUPS[groupKey].title,
      ),
      children: navigationItems
        .filter((item) => item.group === groupKey)
        .map((item) => ({
          key: item.key,
          label: renderMenuLabel(item.icon, item.title),
        })),
    }));
  }

  function renderMobileOptions() {
    return [
      {
        value: OVERVIEW_MENU_KEY,
        label: "Overview",
      },
      ...navigationItems
        .filter((item) => item.key !== OVERVIEW_MENU_KEY)
        .map((item) => ({
          value: item.key,
          label: `${ADMIN_GROUPS[item.group].title}: ${item.title}`,
        })),
    ];
  }

  function handleSelect(key: string) {
    if (isAdminGroupKey(key)) {
      setOpenKeys((openKeys) =>
        openKeys.includes(key)
          ? openKeys.filter((openKey) => openKey !== key)
          : [...openKeys, key],
      );
      return;
    }
    if (key === OVERVIEW_MENU_KEY) {
      navigate({ kind: "index" });
      return;
    }
    if (key === NEWS_MENU_KEY) {
      navigate({ kind: "news-list" });
      return;
    }
    if (sectionByKey.has(key as AdminSection)) {
      navigateToSection(key as AdminSection);
    }
  }

  function renderActiveContent() {
    if (route.kind !== "index") {
      return <NewsAdminPage route={route} />;
    }
    if (route.section == null) {
      return (
        <AdminOverview
          sections={navigationItems}
          onNavigate={(key) => handleSelect(key)}
        />
      );
    }
    const section = sectionByKey.get(route.section);
    return section?.component();
  }

  return (
    <div className="smc-vfill" style={{ flexDirection: "row" }}>
      {!isMobile && (
        <div
          style={{
            background: "#00000005",
            borderRight: "1px solid rgba(5, 5, 5, 0.06)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <Button
            block
            type="text"
            style={{
              borderRadius: 0,
              color: COLORS.GRAY_M,
              height: "44px",
              justifyContent: navCollapsed ? "center" : "flex-start",
              paddingLeft: navCollapsed ? 0 : "24px",
              textAlign: "left",
            }}
            icon={<Icon name="gears" />}
            onClick={() => navigate({ kind: "index" })}
          >
            {navCollapsed ? "" : "Admin"}
          </Button>
          <Menu
            inlineCollapsed={navCollapsed}
            mode="inline"
            items={renderMenuItems()}
            onClick={(e) => handleSelect(e.key)}
            openKeys={navCollapsed ? undefined : openKeys}
            onOpenChange={setOpenKeys}
            selectedKeys={[activeMenuKey]}
            style={{
              background: "#00000005",
              borderBottom: `1px solid ${COLORS.GRAY_DDD}`,
              flex: "1 1 auto",
              minHeight: 0,
              overflowY: "auto",
              width: navCollapsed ? 56 : 250,
            }}
          />
          <Button
            block
            size="small"
            type="text"
            style={{
              color: COLORS.GRAY_M,
              flex: "0 0 auto",
              minHeight: 0,
              padding: "15px 0",
              textAlign: "left",
            }}
            onClick={() => setNavCollapsed(!navCollapsed)}
            icon={
              <Icon
                name={
                  navCollapsed
                    ? "vertical-left-outlined"
                    : "vertical-right-outlined"
                }
              />
            }
          >
            {navCollapsed ? "" : "Hide"}
          </Button>
        </div>
      )}
      <div
        className="smc-vfill"
        style={{
          overflow: "auto",
          padding: isMobile ? "12px" : "18px 24px 32px 24px",
        }}
      >
        {isMobile && (
          <Select
            size="large"
            value={activeMenuKey}
            options={renderMobileOptions()}
            onChange={handleSelect}
            style={{ marginBottom: "12px", width: "100%" }}
          />
        )}
        <Flex align="center" gap="middle" wrap>
          <Title level={3} style={{ marginBottom: 0 }}>
            {title}
          </Title>
          {activeNavItem?.description && (
            <Text type="secondary">{activeNavItem.description}</Text>
          )}
        </Flex>
        <div style={{ marginTop: "12px" }}>
          <SiteSetupBanner onOpenSetup={openSetup} />
        </div>
        <div style={{ marginTop: "16px" }}>{renderActiveContent()}</div>
      </div>
    </div>
  );
}

function getAdminSections({
  closeSiteSettings,
}: {
  closeSiteSettings: () => void;
}): AdminSectionDefinition[] {
  return [
    {
      key: "site-setup",
      title: "Site Setup",
      description: "Check launch setup, bootstrap state, and required actions.",
      icon: "check-square",
      group: "launch",
      component: () => <SiteSetupAdmin />,
    },
    {
      key: "usage-stats",
      title: "Operations & Latency",
      description:
        "Track user-visible latency, alert preferences, and launch health.",
      icon: "line-chart",
      group: "launch",
      component: () => <UsageStatistics />,
    },
    {
      key: "site-settings",
      title: "Site Settings",
      description:
        "Configure site behavior, launch kill switches, email, and infrastructure.",
      icon: "gears",
      group: "launch",
      component: () => <SiteSettings close={closeSiteSettings} />,
    },
    {
      key: "registration-tokens",
      title: "Registration Tokens",
      description: "Control token-gated signup and public signup policy.",
      icon: "sign-in",
      group: "launch",
      component: () => <RegistrationToken />,
    },
    {
      key: "user-search",
      title: "User Search",
      description: "Find users and access account support tools.",
      icon: "users",
      group: "operations",
      component: () => <UserSearch />,
    },
    {
      key: "managed-cpu",
      title: "CPU & Abuse Signals",
      description: "Review CPU usage and operational abuse signals.",
      icon: "line-chart",
      group: "operations",
      component: () => <ManagedCpuAdminOverview />,
    },
    {
      key: "managed-egress",
      title: "Network Egress",
      description:
        "Investigate managed network egress by account, project, and category.",
      icon: "exchange",
      group: "operations",
      component: () => <ManagedEgressAdminOverview />,
    },
    {
      key: "bay-ops",
      title: "Bay Operations",
      description:
        "Inspect bay health, ownership, rehome state, backups, and load.",
      icon: "server",
      group: "operations",
      component: () => <BayOpsAdmin />,
    },
    {
      key: "project-backup-shards",
      title: "Backup Shards",
      description: "Review project backup shard configuration.",
      icon: "database",
      group: "operations",
      component: () => <ProjectBackupShardsAdmin />,
    },
    {
      key: "rootfs",
      title: "RootFS Images",
      description: "Manage runtime images and host-side rootfs availability.",
      icon: "database",
      group: "operations",
      component: () => <RootfsAdmin />,
    },
    {
      key: "sso",
      title: "SSO Providers & Domains",
      description: "Configure identity providers and domain signup policy.",
      icon: "sign-in",
      group: "access",
      component: () => <SsoAdmin />,
    },
    {
      key: "membership-tiers",
      title: "Membership Tiers",
      description: "Manage capability bundles, limits, and tier behavior.",
      icon: "user",
      group: "commercial",
      component: () => <MembershipTiers />,
    },
    {
      key: "software-licenses",
      title: "Software Licenses",
      description: "Manage license packages and commercial access rules.",
      icon: "key",
      group: "commercial",
      component: () => <SoftwareLicensesAdmin />,
    },
    {
      key: "admin-purchase",
      title: "Admin Purchase",
      description: "Create or inspect purchases as an administrator.",
      icon: "shopping-cart",
      group: "commercial",
      component: () => <AdminPurchaseAdmin />,
    },
    {
      key: "site-licenses",
      title: "Site Licenses",
      description: "Manage site license records and institutional access.",
      icon: "users",
      group: "commercial",
      component: () => <SiteLicensesAdmin />,
    },
  ];
}

function getNavigationItems(
  sections: AdminSectionDefinition[],
): AdminNavigationItem[] {
  const items: AdminNavigationItem[] = [
    {
      key: OVERVIEW_MENU_KEY,
      title: "Overview",
      description: "Choose an admin area.",
      icon: "gears",
      group: "launch",
    },
    ...sections.map((section) => ({
      key: section.key,
      title: section.title,
      description: section.description,
      icon: section.icon,
      group: section.group,
    })),
  ];
  items.push({
    key: NEWS_MENU_KEY,
    title: "News",
    description: "Publish news, events, and system notices.",
    icon: "file-alt",
    group: "content",
  });
  return items;
}

function getActiveMenuKey(route: AdminRoute): AdminMenuKey {
  if (route.kind !== "index") return NEWS_MENU_KEY;
  return route.section ?? OVERVIEW_MENU_KEY;
}

function AdminOverview({
  onNavigate,
  sections,
}: {
  onNavigate: (key: string) => void;
  sections: AdminNavigationItem[];
}) {
  const primarySections = sections.filter(
    (section) => section.key !== OVERVIEW_MENU_KEY,
  );
  return (
    <div style={{ padding: "6px 0 24px 0" }}>
      {Object.entries(ADMIN_GROUPS).map(([groupKey, group]) => {
        const groupSections = primarySections.filter(
          (section) => section.group === groupKey,
        );
        if (groupSections.length === 0) return null;
        return (
          <div key={groupKey} style={{ marginBottom: "28px" }}>
            <Flex align="center" gap="small" style={{ marginBottom: "12px" }}>
              <Icon name={group.icon} />
              <Title level={4} style={{ marginBottom: 0 }}>
                {group.title}
              </Title>
            </Flex>
            <Flex wrap gap="middle">
              {groupSections.map((section) => (
                <Card
                  key={section.key}
                  hoverable
                  size="small"
                  style={{ minWidth: 260, width: 320 }}
                  onClick={() => onNavigate(section.key)}
                >
                  <Card.Meta
                    avatar={<Icon name={section.icon} />}
                    title={section.title}
                    description={section.description}
                  />
                </Card>
              ))}
            </Flex>
          </div>
        );
      })}
    </div>
  );
}
