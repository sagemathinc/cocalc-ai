import type { SettingsPageDefinition } from "@cocalc/frontend/account/settings-page";
import { labels } from "@cocalc/frontend/i18n";
import { defineMessage } from "react-intl";
import Purchases from "./purchases";

export const PURCHASES_SETTINGS_PAGE = {
  component: PurchasesPage,
  description: defineMessage({
    id: "account.settings.overview.purchases",
    defaultMessage: "View purchase history and receipts.",
  }),
  icon: "money-check",
  key: "purchases",
  label: labels.purchases,
} satisfies SettingsPageDefinition;

export default function PurchasesPage() {
  return (
    <div>
      <Purchases noTitle />
    </div>
  );
}
