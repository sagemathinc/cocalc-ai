import { Select, Tabs } from "antd";
import { useIntl } from "react-intl";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  getVisibleSettingsNavigation,
  useSettingsNavigationContext,
} from "./settings-navigation";
import { getRegisteredSettingsPageDefinition } from "./settings-page-registry";
import { openAccountSettings } from "./settings-routing";
import type { SettingsPageType } from "@cocalc/util/types/settings";

export default function SettingsDrawerContent() {
  const intl = useIntl();
  const context = useSettingsNavigationContext();
  const active = useTypedRedux("account", "active_page");
  const pages = getVisibleSettingsNavigation(context)
    .flatMap((node) =>
      node.type === "page" ? [node.page] : node.pages.map(({ page }) => page),
    )
    .filter((page) => page !== "index");
  const page = pages.find((key) => key === active) ?? pages[0];
  const definition = getRegisteredSettingsPageDefinition(page);
  const Component = definition?.component;
  const items = pages.map((key) => ({
    key,
    label: intl.formatMessage(getRegisteredSettingsPageDefinition(key)!.label),
  }));
  const navigate = (key: string) =>
    openAccountSettings({ page: key as SettingsPageType });
  return (
    <>
      <Select
        aria-label="Settings section"
        showSearch
        optionFilterProp="label"
        value={page}
        onChange={navigate}
        options={items.map(({ key, label }) => ({ value: key, label }))}
        style={{ width: "100%", flex: "0 0 auto" }}
      />
      <Tabs
        aria-label="Account settings sections"
        activeKey={page}
        onChange={navigate}
        items={items}
        size="small"
        style={{ flex: "0 0 auto", minWidth: 0 }}
      />
      <div style={{ overflow: "auto", flex: 1, minHeight: 0, minWidth: 0 }}>
        {Component && <Component key={page} />}
      </div>
    </>
  );
}
