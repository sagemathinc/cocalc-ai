/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The account page. This is what you see when you
click "Account" in the upper right.  It has tabs
for different account related information
and configuration.
*/

import type { SettingsPageType } from "@cocalc/util/types/settings";
import { Button, Flex, Menu, Select, Space } from "antd";
import { useEffect, useState } from "react";
import { MessageDescriptor, useIntl } from "react-intl";
import { SignOut } from "@cocalc/frontend/account/sign-out";
import {
  React,
  redux,
  useIsMountedRef,
  useTypedRedux,
  useWindowDimensions,
} from "@cocalc/frontend/app-framework";
import { Icon, Loading, Title } from "@cocalc/frontend/components";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import BalanceButton from "@cocalc/frontend/purchases/balance-button";
import { COLORS } from "@cocalc/util/theme";
import { I18NSelector } from "./i18n-selector";
import { SETTINGS_OVERVIEW_PAGE } from "./settings-index";
import {
  getSettingsNavigationGroupKey,
  getVisibleSettingsNavigation,
  useSettingsNavigationContext,
} from "./settings-navigation";
import { SETTINGS_PAGE_DEFINITIONS } from "./settings-page-registry";
import {
  renderSettingsPageIcon,
  type SettingsPageDefinition,
  type SettingsPageIcon,
} from "./settings-page";
import {
  applyAccountSettingsRoute,
  getAccountSettingsRouteFromState,
  isAccountSettingsPageKey,
} from "./settings-routing";
import { lite, project_id } from "@cocalc/frontend/lite";

// Type for valid menu keys
type MenuKey =
  | "settings"
  | "billing"
  | "support"
  | "signout"
  | "profile"
  | SettingsPageType
  | string;

type SettingsNavigation = {
  contentComponents: Partial<Record<SettingsPageType, React.ComponentType>>;
  menuItems: any[];
  titles: Partial<Record<SettingsPageType, string>>;
};

const pageDefinitions = {
  index: SETTINGS_OVERVIEW_PAGE,
  ...SETTINGS_PAGE_DEFINITIONS,
} satisfies Record<SettingsPageType, SettingsPageDefinition>;

// give up on trying to load account info and redirect to landing page.
// Do NOT make too short, since loading account info might takes ~10 seconds, e,g., due
// to slow network or some backend failure that times and retires involving
// changefeeds.
const LOAD_ACCOUNT_INFO_TIMEOUT = 15_000;

export const AccountPage: React.FC = () => {
  const intl = useIntl();
  const [hidden, setHidden] = useState(IS_MOBILE);

  const { width: windowWidth } = useWindowDimensions();
  const isWide = windowWidth > 800;

  const raw_active_page = useTypedRedux("account", "active_page") ?? "index";
  const active_page = getAccountSettingsRouteFromState({
    active_page: raw_active_page,
  }).page;
  const navigationContext = useSettingsNavigationContext();
  const activeGroupKey = getSettingsNavigationGroupKey(active_page);
  const activeGroupOpenKeys = activeGroupKey == null ? [] : [activeGroupKey];
  const [manualOpenKeys, setManualOpenKeys] = useState<string[] | undefined>();
  const is_logged_in = useTypedRedux("account", "is_logged_in");
  const account_id = useTypedRedux("account", "account_id");
  const get_api_key = useTypedRedux("page", "get_api_key");

  useEffect(() => {
    if (!lite) return;
    if (raw_active_page !== "admin") return;
    applyAccountSettingsRoute(redux.getActions("account"), { page: "index" });
  }, [raw_active_page]);

  function handle_select(key: MenuKey): void {
    const accountActions = redux.getActions("account");
    if (key === "billing") {
      redux.getActions("billing").update_customer();
      return;
    }
    if (key === "signout") {
      return;
    }
    if (typeof key === "string" && isAccountSettingsPageKey(key)) {
      applyAccountSettingsRoute(accountActions, { page: key });
    }
  }

  function renderLabel({
    icon,
    label,
  }: {
    icon: SettingsPageIcon;
    label: MessageDescriptor;
  }): React.ReactNode {
    return (
      <span>
        {renderSettingsPageIcon(icon, "menu")}
        {!hidden && <> {intl.formatMessage(label)}</>}
      </span>
    );
  }

  function getNavigation(): SettingsNavigation {
    const menuItems: any[] = [];
    const contentComponents: Partial<
      Record<SettingsPageType, React.ComponentType>
    > = {};
    const titles: Partial<Record<SettingsPageType, string>> = {};

    function addPage(page: SettingsPageType): any | undefined {
      const definition = pageDefinitions[page];
      contentComponents[page] = definition.component;
      titles[page] = intl.formatMessage(definition.label);
      return { key: page, label: renderLabel(definition) };
    }

    for (const node of getVisibleSettingsNavigation(navigationContext)) {
      if (node.type === "page") {
        const item = addPage(node.page);
        if (item != null) {
          menuItems.push(item);
        }
        continue;
      }
      const childItems = node.pages
        .map(({ page }) => addPage(page))
        .filter((item): item is any => item != null);
      if (childItems.length === 0) continue;
      menuItems.push({
        key: node.key,
        mobilePrefix: intl.formatMessage(node.label),
        label: renderLabel(node),
        children: childItems,
      });
    }

    return { contentComponents, menuItems, titles };
  }

  const { contentComponents, menuItems: tabs, titles } = getNavigation();
  const mobileNavigationOptions = getMobileNavigationOptions(tabs);
  const menuOpenKeys = manualOpenKeys ?? activeGroupOpenKeys;

  function renderTitle() {
    return <Title level={3}>{titles[active_page] ?? titles["index"]}</Title>;
  }

  function renderExtraContent() {
    return (
      <Space wrap>
        {navigationContext.isCommercial ? <BalanceButton /> : undefined}
        <I18NSelector isWide={isWide} />
        {!lite && <SignOut everywhere={false} narrow={!isWide} />}
      </Space>
    );
  }

  function renderActiveContent() {
    const ActiveContent =
      contentComponents[active_page] ?? contentComponents["index"];
    return ActiveContent == null ? undefined : <ActiveContent />;
  }

  function renderMobileLoggedInView(): React.JSX.Element {
    if (!account_id) {
      return (
        <div style={{ textAlign: "center", paddingTop: "15px" }}>
          <Loading theme={"medium"} />
        </div>
      );
    }

    return (
      <div
        className="smc-vfill"
        data-cocalc-mobile-account-settings
        style={{
          overflow: "auto",
          padding: "8px 10px 0 10px",
        }}
      >
        {lite && (
          <Button
            block
            size="large"
            style={{ marginBottom: "8px" }}
            onClick={() => {
              redux.getActions("page").set_active_tab(project_id);
            }}
          >
            Close
          </Button>
        )}
        <Select
          size="large"
          value={active_page}
          options={mobileNavigationOptions}
          onChange={(key) => handle_select(key)}
          style={{ width: "100%" }}
        />
        <Flex style={{ marginTop: "8px", gap: "8px" }} align="center" wrap>
          {renderTitle()}
          {renderExtraContent()}
        </Flex>
        {renderActiveContent()}
      </div>
    );
  }

  function render_logged_in_view(): React.JSX.Element {
    if (!account_id) {
      return (
        <div style={{ textAlign: "center", paddingTop: "15px" }}>
          <Loading theme={"medium"} />
        </div>
      );
    }
    function handleHideToggle() {
      setHidden(!hidden);
    }

    if (IS_MOBILE) {
      return renderMobileLoggedInView();
    }

    return (
      <div className="smc-vfill" style={{ flexDirection: "row" }}>
        <div
          style={{
            background: "#00000005",
            borderRight: "1px solid rgba(5, 5, 5, 0.06)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {lite && (
            <div
              style={{
                textAlign: "center",
                margin: "15px 0",
              }}
            >
              <Button
                size="large"
                style={{ width: "80%" }}
                onClick={() => {
                  redux.getActions("page").set_active_tab(project_id);
                }}
              >
                Close
              </Button>
            </div>
          )}
          <Menu
            className={hidden ? "account-menu-inline-collapsed" : undefined}
            openKeys={menuOpenKeys}
            onOpenChange={setManualOpenKeys}
            mode="inline"
            items={tabs}
            onClick={(e) => {
              handle_select(e.key);
            }}
            selectedKeys={
              activeGroupKey ? [activeGroupKey, active_page] : [active_page]
            }
            inlineIndent={hidden ? 0 : 24}
            style={{
              width: hidden ? 50 : 220,
              background: "#00000005",
              flex: "1 1 auto",
              overflowY: "auto",
              minHeight: 0,
              borderBottom: `1px solid ${COLORS.GRAY_DDD}`,
            }}
          />
          <Button
            block
            size="small"
            type="text"
            style={{
              flex: "0 0 auto",
              minHeight: 0,
              textAlign: "left",
              padding: "15px 0",
              color: COLORS.GRAY_M,
            }}
            onClick={handleHideToggle}
            icon={
              <Icon
                name={
                  hidden ? "vertical-left-outlined" : "vertical-right-outlined"
                }
              />
            }
          >
            {hidden ? "" : "Hide"}
          </Button>
        </div>
        <div
          className="smc-vfill"
          style={{
            overflow: "auto",
            paddingLeft: "15px",
            paddingRight: "15px",
          }}
        >
          <Flex style={{ marginTop: "5px" }} wrap>
            {renderTitle()}
            <div style={{ flex: 1 }} />
            {renderExtraContent()}
          </Flex>
          {renderActiveContent()}
        </div>
      </div>
    );
  }

  return (
    <div className="smc-vfill">
      {is_logged_in && !get_api_key ? (
        render_logged_in_view()
      ) : (
        <RedirectToNextApp />
      )}
    </div>
  );
};

function getMobileNavigationOptions(tabs: any[]) {
  const options: { label: React.ReactNode; value: string }[] = [];
  for (const tab of tabs) {
    if (Array.isArray(tab.children)) {
      const prefix = tab.mobilePrefix;
      for (const subTab of tab.children) {
        options.push({
          value: subTab.key,
          label: (
            <span>
              {prefix != null && (
                <span style={{ color: COLORS.GRAY_M }}>{prefix}: </span>
              )}
              {subTab.label}
            </span>
          ),
        });
      }
      continue;
    }
    options.push({ value: tab.key, label: tab.label });
  }
  return options;
}

declare var DEBUG;

function RedirectToNextApp({}) {
  const isMountedRef = useIsMountedRef();

  useEffect(() => {
    const f = () => {
      if (isMountedRef.current && !DEBUG) {
        // didn't get signed in so go to landing page
        window.location.href = appBasePath;
      }
    };
    setTimeout(f, LOAD_ACCOUNT_INFO_TIMEOUT);
  }, []);

  return <Loading theme="medium" />;
}
