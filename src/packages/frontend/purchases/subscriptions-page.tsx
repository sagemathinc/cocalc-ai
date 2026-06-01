import Subscriptions from "./subscriptions";
import { UseBalance } from "@cocalc/frontend/account/other-settings";
import type { SettingsPageDefinition } from "@cocalc/frontend/account/settings-page";
import { Button, Flex } from "antd";
import { useState } from "react";
import { defineMessage } from "react-intl";
import { Icon } from "@cocalc/frontend/components/icon";
import { labels } from "@cocalc/frontend/i18n";
import MembershipPurchaseModal from "@cocalc/frontend/account/membership-purchase-modal";

export const SUBSCRIPTIONS_SETTINGS_PAGE = {
  component: SubscriptionsPage,
  description: defineMessage({
    id: "account.settings.overview.subscriptions",
    defaultMessage: "View and manage your active subscriptions.",
  }),
  icon: "calendar",
  key: "subscriptions",
  label: labels.subscriptions,
} satisfies SettingsPageDefinition;

export default function SubscriptionsPage() {
  const [membershipOpen, setMembershipOpen] = useState(false);
  return (
    <div>
      <Flex style={{ width: "100%", margin: "5px 0", alignItems: "center" }}>
        <UseBalance minimal />
        <div style={{ flex: 1 }} />
        <Button type="primary" onClick={() => setMembershipOpen(true)}>
          <Icon name="user" /> Change Membership
        </Button>
      </Flex>
      <MembershipPurchaseModal
        open={membershipOpen}
        onClose={() => setMembershipOpen(false)}
      />
      <Subscriptions />
    </div>
  );
}
