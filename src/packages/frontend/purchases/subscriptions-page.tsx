import type { SettingsPageDefinition } from "@cocalc/frontend/account/settings-page";
import { labels } from "@cocalc/frontend/i18n";
import { defineMessage } from "react-intl";
import Subscriptions from "./subscriptions";

export const SUBSCRIPTIONS_SETTINGS_PAGE = {
  component: SubscriptionsPage,
  description: defineMessage({
    id: "account.settings.overview.subscriptions",
    defaultMessage: "Review and manage recurring subscriptions.",
  }),
  icon: "calendar",
  key: "subscriptions",
  label: labels.subscriptions,
} satisfies SettingsPageDefinition;

export default function SubscriptionsPage() {
  return <Subscriptions />;
}
