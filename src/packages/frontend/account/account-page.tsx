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
import { useIntl } from "react-intl";
import { SignOut } from "@cocalc/frontend/account/sign-out";
import {
  React,
  redux,
  useIsMountedRef,
  useTypedRedux,
  useWindowDimensions,
} from "@cocalc/frontend/app-framework";
import { Icon, IconName, Loading, Title } from "@cocalc/frontend/components";
import AIAvatar from "@cocalc/frontend/components/ai-avatar";
import { Footer } from "@cocalc/frontend/customize";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import { labels } from "@cocalc/frontend/i18n";
import BalanceButton from "@cocalc/frontend/purchases/balance-button";
import PaymentMethodsPage from "@cocalc/frontend/purchases/payment-methods-page";
import PaymentsPage from "@cocalc/frontend/purchases/payments-page";
import PurchasesPage from "@cocalc/frontend/purchases/purchases-page";
import StatementsPage from "@cocalc/frontend/purchases/statements-page";
import { StorePage, VoucherCenterPage } from "@cocalc/frontend/store";
import SubscriptionsPage from "@cocalc/frontend/purchases/subscriptions-page";
import { SupportTickets } from "@cocalc/frontend/support";
import { COLORS } from "@cocalc/util/theme";
import { AccountPreferencesAI } from "./account-preferences-ai";
import {
  AccountPreferencesAppearance,
  APPEARANCE_ICON_NAME,
} from "./account-preferences-appearance";
import {
  AccountPreferencesCommunication,
  COMMUNICATION_ICON_NAME,
} from "./account-preferences-communication";
import {
  AccountPreferencesEditor,
  EDITOR_ICON_NAME,
} from "./account-preferences-editor";
import {
  AccountPreferencesKeyboard,
  KEYBOARD_ICON_NAME,
} from "./account-preferences-keyboard";
import {
  AccountPreferencesOther,
  OTHER_ICON_NAME,
} from "./account-preferences-other";
import {
  ACCOUNT_PREFERENCES_ICON_NAME,
  ACCOUNT_PROFILE_ICON_NAME,
  AccountPreferencesProfile,
} from "./account-preferences-profile";
import {
  AccountPreferencesSecurity,
  KEYS_ICON_NAME,
} from "./account-preferences-security";
import { I18NSelector } from "./i18n-selector";
import { LicensesPage } from "./licenses/licenses-page";
import { SettingsOverview } from "./settings-index";
import {
  applyAccountSettingsRoute,
  getAccountSettingsGroupKey,
  getAccountSettingsGroupPages,
  getAccountSettingsRouteFromState,
  isAccountSettingsPageKey,
} from "./settings-routing";
import MembershipBadge from "./membership-badge";
import { lite, project_id } from "@cocalc/frontend/lite";

export const ACCOUNT_SETTINGS_ICON_NAME: IconName = "settings";

// Type for valid menu keys
type MenuKey =
  | "settings"
  | "billing"
  | "support"
  | "signout"
  | "profile"
  | SettingsPageType
  | string;

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
  const activeGroupKey = getAccountSettingsGroupKey(active_page);
  const activeGroupOpenKeys = activeGroupKey == null ? [] : [activeGroupKey];
  const [manualOpenKeys, setManualOpenKeys] = useState<string[] | undefined>();
  const is_logged_in = useTypedRedux("account", "is_logged_in");
  const account_id = useTypedRedux("account", "account_id");
  const is_commercial = useTypedRedux("customize", "is_commercial");
  const is_admin = !!useTypedRedux("account", "is_admin");
  const zendesk = !!useTypedRedux("customize", "zendesk");
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

  function getTabs(): any[] {
    const pageItems: Record<SettingsPageType, any> = {
      ai: {
        children: active_page === "ai" && <AccountPreferencesAI />,
        label: (
          <span>
            <AIAvatar size={16} style={{ top: "-5px" }} />{" "}
            {intl.formatMessage(labels.ai)}
          </span>
        ),
      },
      appearance: {
        children: active_page === "appearance" && (
          <AccountPreferencesAppearance />
        ),
        label: (
          <span>
            <Icon name={APPEARANCE_ICON_NAME} />{" "}
            {intl.formatMessage(labels.appearance)}
          </span>
        ),
      },
      communication: {
        children: active_page === "communication" && (
          <AccountPreferencesCommunication />
        ),
        label: (
          <span>
            <Icon name={COMMUNICATION_ICON_NAME} />{" "}
            {intl.formatMessage(labels.communication)}
          </span>
        ),
      },
      editor: {
        children: active_page === "editor" && <AccountPreferencesEditor />,
        label: (
          <span>
            <Icon name={EDITOR_ICON_NAME} /> {intl.formatMessage(labels.editor)}
          </span>
        ),
      },
      index: {
        children: active_page === "index" && <SettingsOverview />,
        label: (
          <span style={{ fontWeight: "bold" }}>
            <Icon name={ACCOUNT_SETTINGS_ICON_NAME} />{" "}
            {intl.formatMessage(labels.settings)}
          </span>
        ),
      },
      keyboard: {
        children: active_page === "keyboard" && <AccountPreferencesKeyboard />,
        label: (
          <span>
            <Icon name={KEYBOARD_ICON_NAME} />{" "}
            {intl.formatMessage(labels.keyboard)}
          </span>
        ),
      },
      keys: {
        children: active_page === "keys" && <AccountPreferencesSecurity />,
        label: (
          <span>
            <Icon name={KEYS_ICON_NAME} />{" "}
            {intl.formatMessage(labels.ssh_and_api_keys)}
          </span>
        ),
      },
      licenses: {
        children: active_page === "licenses" && <LicensesPage />,
        label: (
          <span>
            <Icon name="key" /> {intl.formatMessage(labels.licenses)}
          </span>
        ),
      },
      other: {
        children: active_page === "other" && <AccountPreferencesOther />,
        label: (
          <span>
            <Icon name={OTHER_ICON_NAME} /> {intl.formatMessage(labels.other)}
          </span>
        ),
      },
      "payment-methods": {
        children: active_page === "payment-methods" && <PaymentMethodsPage />,
        label: (
          <span>
            <Icon name="credit-card" />{" "}
            {intl.formatMessage(labels.payment_methods)}
          </span>
        ),
      },
      payments: {
        children: active_page === "payments" && <PaymentsPage />,
        label: (
          <span>
            <Icon name="credit-card" /> {intl.formatMessage(labels.payments)}
          </span>
        ),
      },
      profile: {
        children: active_page === "profile" && <AccountPreferencesProfile />,
        label: (
          <span>
            <Icon name={ACCOUNT_PROFILE_ICON_NAME} />{" "}
            {intl.formatMessage(labels.profile)}
          </span>
        ),
      },
      purchases: {
        children: active_page === "purchases" && <PurchasesPage />,
        label: (
          <span>
            <Icon name="money-check" /> {intl.formatMessage(labels.purchases)}
          </span>
        ),
      },
      statements: {
        children: active_page === "statements" && <StatementsPage />,
        label: (
          <span>
            <Icon name="calendar-week" />{" "}
            {intl.formatMessage(labels.statements)}
          </span>
        ),
      },
      store: {
        children: active_page === "store" && <StorePage />,
        label: (
          <span>
            <Icon name="shopping-cart" /> Store
          </span>
        ),
      },
      subscriptions: {
        children: active_page === "subscriptions" && <SubscriptionsPage />,
        label: (
          <span>
            <Icon name="calendar" /> {intl.formatMessage(labels.subscriptions)}
          </span>
        ),
      },
      support: {
        children: active_page === "support" && <SupportTickets />,
        label: (
          <span>
            <Icon name="medkit" /> {intl.formatMessage(labels.support)}
          </span>
        ),
      },
      vouchers: {
        children: active_page === "vouchers" && <VoucherCenterPage />,
        label: (
          <span>
            <Icon name="gift" /> Voucher Center
          </span>
        ),
      },
    };

    function getPageItem(page: SettingsPageType): any {
      return { key: page, ...pageItems[page] };
    }

    function isVisiblePage(page: SettingsPageType): boolean {
      if (lite && (page === "communication" || page === "keys")) return false;
      if (
        page === "purchases" ||
        page === "payments" ||
        page === "payment-methods" ||
        page === "statements"
      ) {
        return is_commercial;
      }
      return true;
    }

    const items: any[] = [
      getPageItem("index"),
      getPageItem("profile"),
      {
        key: "preferences",
        mobilePrefix: intl.formatMessage(labels.preferences),
        label: (
          <span>
            <Icon name={ACCOUNT_PREFERENCES_ICON_NAME} />{" "}
            {intl.formatMessage(labels.preferences)}
          </span>
        ),
        children: getAccountSettingsGroupPages("preferences")
          .filter(isVisiblePage)
          .map(getPageItem),
      },
    ];

    items.push({ type: "divider" });

    if (is_commercial || is_admin) {
      items.push({
        key: "billing",
        mobilePrefix: intl.formatMessage(labels.billing),
        label: (
          <span>
            <Icon name="money-check" /> {intl.formatMessage(labels.billing)}
          </span>
        ),
        children: getAccountSettingsGroupPages("billing")
          .filter(isVisiblePage)
          .map(getPageItem),
      });
      items.push({ type: "divider" });
    }

    if (zendesk) {
      items.push({ type: "divider" });
      items.push(getPageItem("support"));
    }

    return items;
  }

  const tabs = getTabs();
  const mobileNavigationOptions = getMobileNavigationOptions(tabs);
  const menuOpenKeys = manualOpenKeys ?? activeGroupOpenKeys;

  // Process tabs to handle nested children uniformly.
  const children = {};
  const titles = {}; // Always store full labels for renderTitle()
  for (const tab of tabs) {
    if (tab.type == "divider") {
      continue;
    }
    if (Array.isArray(tab.children)) {
      const subTabs = tab.children;
      tab.label = hidden ? (
        <span style={{ paddingLeft: "5px" }}>
          {tab.label.props.children[0]}
        </span>
      ) : (
        tab.label
      );
      tab.children = subTabs.map((subTab) => {
        // Extract just the icon (first child) from the span when hidden
        const label = hidden ? (
          <span style={{ paddingLeft: "5px" }}>
            {subTab.label.props.children[0]}
          </span>
        ) : (
          subTab.label
        );
        return {
          key: subTab.key,
          label,
        };
      });
      for (const subTab of subTabs) {
        children[subTab.key] = subTab.children;
        titles[subTab.key] = subTab.label; // Always store original full label
      }
    } else {
      // Store original full label for renderTitle()
      const originalLabel = tab.label;
      // Extract just the icon (first child) from the span when hidden
      tab.label = hidden ? (
        <span style={{ paddingLeft: "5px" }}>
          {tab.label.props.children[0]}
        </span>
      ) : (
        tab.label
      );
      children[tab.key] = tab.children;
      titles[tab.key] = originalLabel; // Store original label
      delete tab.children;
    }
  }

  function renderTitle() {
    return <Title level={3}>{titles[active_page] ?? titles["index"]}</Title>;
  }

  function renderExtraContent() {
    return (
      <Space wrap>
        {is_commercial ? <BalanceButton /> : undefined}
        {!lite && <MembershipBadge />}
        <I18NSelector isWide={isWide} />
        {!lite && (
          <SignOut everywhere={false} highlight={true} narrow={!isWide} />
        )}
      </Space>
    );
  }

  function renderActiveContent() {
    return children[active_page] ?? children["index"];
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
        <Footer />
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
              width: hidden ? 50 : 200,
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
          <Footer />
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
    if (tab.type === "divider") continue;
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
