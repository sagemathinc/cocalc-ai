import { UseBalance } from "@cocalc/frontend/account/balance-toward-subs";
import type { SettingsPageDefinition } from "@cocalc/frontend/account/settings-page";
import { labels } from "@cocalc/frontend/i18n";
import { defineMessage } from "react-intl";
import PaymentMethods from "./payment-methods";

export const PAYMENT_METHODS_SETTINGS_PAGE = {
  component: PaymentsPage,
  description: defineMessage({
    id: "account.settings.overview.payment_methods",
    defaultMessage: "Manage saved payment methods.",
  }),
  icon: "credit-card",
  key: "payment-methods",
  label: labels.payment_methods,
} satisfies SettingsPageDefinition;

export default function PaymentsPage() {
  return (
    <div>
      <PaymentMethods
        balanceComponent={<UseBalance style={{ marginTop: "20px" }} />}
      />
    </div>
  );
}
