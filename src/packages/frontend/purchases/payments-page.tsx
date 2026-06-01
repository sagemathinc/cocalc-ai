import type { SettingsPageDefinition } from "@cocalc/frontend/account/settings-page";
import { labels } from "@cocalc/frontend/i18n";
import { defineMessage } from "react-intl";
import Payments from "./payments";

export const PAYMENTS_SETTINGS_PAGE = {
  component: PaymentsPage,
  description: defineMessage({
    id: "account.settings.overview.payments",
    defaultMessage: "Manage payment methods and transaction history.",
  }),
  icon: "credit-card",
  key: "payments",
  label: labels.payments,
} satisfies SettingsPageDefinition;

export default function PaymentsPage() {
  return (
    <div>
      <Payments />
    </div>
  );
}
