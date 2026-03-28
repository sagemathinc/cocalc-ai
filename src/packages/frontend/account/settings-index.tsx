/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// cSpell:ignore payg

import { Card, Divider, Flex } from "antd";
import { defineMessages, useIntl } from "react-intl";

import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import AIAvatar from "@cocalc/frontend/components/ai-avatar";
import { labels } from "@cocalc/frontend/i18n";
import { lite } from "@cocalc/frontend/lite";
import { COLORS } from "@cocalc/util/theme";
import type { NavigatePath } from "@cocalc/util/types/settings";
import { APPEARANCE_ICON_NAME } from "./account-preferences-appearance";
import { COMMUNICATION_ICON_NAME } from "./account-preferences-communication";
import { EDITOR_ICON_NAME } from "./account-preferences-editor";
import { KEYBOARD_ICON_NAME } from "./account-preferences-keyboard";
import { OTHER_ICON_NAME } from "./account-preferences-other";
import { ACCOUNT_PROFILE_ICON_NAME } from "./account-preferences-profile";
import { KEYS_ICON_NAME } from "./account-preferences-security";
import {
  applyAccountSettingsRoute,
  parseAccountSettingsRoute,
} from "./settings-routing";

const MESSAGES = defineMessages({
  title: {
    id: "account.settings.overview.title",
    defaultMessage: "Settings Overview",
  },
  profile: {
    id: "account.settings.overview.profile",
    defaultMessage:
      "Manage your personal information, avatar, and account details.",
  },
  appearance: {
    id: "account.settings.overview.appearance",
    defaultMessage:
      "Customize the visual experience via color themes, {dark_mode}, language, and visual settings.",
  },
  editor: {
    id: "account.settings.overview.editor",
    defaultMessage:
      "Customize code editor behavior, indentation, and content options.",
  },
  keyboard: {
    id: "account.settings.overview.keyboard",
    defaultMessage: "Keyboard shortcuts.",
  },
  ai: {
    id: "account.settings.overview.ai",
    defaultMessage: "Configure AI assistant settings and integrations.",
  },
  communication: {
    id: "account.settings.overview.communication",
    defaultMessage: "Notification preferences and communication settings.",
  },
  keys: {
    id: "account.settings.overview.keys",
    defaultMessage: "Manage API keys and setup SSH keys.",
  },
  other: {
    id: "account.settings.overview.other",
    defaultMessage: "Miscellaneous settings and options.",
  },
  billing: {
    id: "account.settings.overview.billing",
    defaultMessage:
      "Manage memberships, subscriptions, and billing information.",
  },
  store: {
    id: "account.settings.overview.store",
    defaultMessage:
      "Buy memberships and vouchers, then jump directly to project host billing.",
  },
  vouchers: {
    id: "account.settings.overview.vouchers",
    defaultMessage:
      "Browse voucher batches, redeemed codes, admin notes, and redeem links.",
  },
  subscriptions: {
    id: "account.settings.overview.subscriptions",
    defaultMessage: "View and manage your active subscriptions.",
  },
  licenses: {
    id: "account.settings.overview.licenses",
    defaultMessage: "Manage your software licenses.",
  },
  payg: {
    id: "account.settings.overview.payg",
    defaultMessage: "Configure pay-as-you-go usage and billing.",
  },
  purchases: {
    id: "account.settings.overview.purchases",
    defaultMessage: "View purchase history and receipts.",
  },
  payments: {
    id: "account.settings.overview.payments",
    defaultMessage: "Manage payment methods and transaction history.",
  },
  statements: {
    id: "account.settings.overview.statements",
    defaultMessage: "View detailed billing statements and invoices.",
  },
  files: {
    id: "account.settings.overview.files",
    defaultMessage: "Manage published files and public sharing.",
  },
  cloud: {
    id: "account.settings.overview.cloud",
    defaultMessage: "Manage cloud file system storage.",
  },
  support: {
    id: "account.settings.overview.support",
    defaultMessage: "Access support tickets and help resources.",
  },
});

const CARD_PROPS = {
  size: "small" as const,
  hoverable: true,
  style: { width: 300, minWidth: 250 },
} as const;

// TODO: highlighting a few cards is a good idea, but better to do this later...
const HIGHLIGHTED_CARD_PROPS = CARD_PROPS; // = {
//   ...CARD_PROPS,
//   style: {
//     ...CARD_PROPS.style,
//     border: `2px solid ${COLORS.BLUE_LLL}`,
//   },
// } as const;

const FLEX_PROPS = {
  wrap: true as const,
  gap: "15px",
  style: { marginBottom: "40px" },
} as const;

export function SettingsOverview() {
  const intl = useIntl();
  const is_commercial = useTypedRedux("customize", "is_commercial");
  const isAdmin = !!useTypedRedux("account", "is_admin");
  const zendesk = !!useTypedRedux("customize", "zendesk");

  function handleNavigate(path: NavigatePath) {
    const route = parseAccountSettingsRoute(path);
    if (route) {
      applyAccountSettingsRoute(redux.getActions("account"), route);
    }
  }

  return (
    <div style={{ padding: "20px" }}>
      <Flex {...FLEX_PROPS}>
        <Card
          {...HIGHLIGHTED_CARD_PROPS}
          onClick={() => handleNavigate("settings/profile")}
        >
          <Card.Meta
            avatar={<Icon name={ACCOUNT_PROFILE_ICON_NAME} />}
            title={intl.formatMessage(labels.profile)}
            description={intl.formatMessage(MESSAGES.profile)}
          />
        </Card>
        <Card
          {...HIGHLIGHTED_CARD_PROPS}
          onClick={() => handleNavigate("settings/preferences/appearance")}
        >
          <Card.Meta
            avatar={<Icon name={APPEARANCE_ICON_NAME} />}
            title={intl.formatMessage(labels.appearance)}
            description={intl.formatMessage(MESSAGES.appearance, {
              dark_mode: (
                <span
                  style={{
                    backgroundColor: COLORS.GRAY_DD,
                    color: COLORS.GRAY_LLL,
                    paddingLeft: "3px",
                    paddingRight: "3px",
                  }}
                >
                  dark mode
                </span>
              ),
            })}
          />
        </Card>
        <Card
          {...CARD_PROPS}
          onClick={() => handleNavigate("settings/preferences/editor")}
        >
          <Card.Meta
            avatar={<Icon name={EDITOR_ICON_NAME} />}
            title={intl.formatMessage(labels.editor)}
            description={intl.formatMessage(MESSAGES.editor)}
          />
        </Card>
        <Card
          {...CARD_PROPS}
          onClick={() => handleNavigate("settings/preferences/keyboard")}
        >
          <Card.Meta
            avatar={<Icon name={KEYBOARD_ICON_NAME} />}
            title={intl.formatMessage(labels.keyboard)}
            description={intl.formatMessage(MESSAGES.keyboard)}
          />
        </Card>
        <Card
          {...CARD_PROPS}
          onClick={() => handleNavigate("settings/preferences/ai")}
        >
          <Card.Meta
            avatar={<AIAvatar size={24} />}
            title={intl.formatMessage(labels.ai)}
            description={intl.formatMessage(MESSAGES.ai)}
          />
        </Card>
        {!lite && (
          <Card
            {...CARD_PROPS}
            onClick={() => handleNavigate("settings/preferences/communication")}
          >
            <Card.Meta
              avatar={<Icon name={COMMUNICATION_ICON_NAME} />}
              title={intl.formatMessage(labels.communication)}
              description={intl.formatMessage(MESSAGES.communication)}
            />
          </Card>
        )}
        {!lite && (
          <Card
            {...CARD_PROPS}
            onClick={() => handleNavigate("settings/preferences/keys")}
          >
            <Card.Meta
              avatar={<Icon name={KEYS_ICON_NAME} />}
              title={intl.formatMessage(labels.ssh_and_api_keys)}
              description={intl.formatMessage(MESSAGES.keys)}
            />
          </Card>
        )}
        <Card
          {...CARD_PROPS}
          onClick={() => handleNavigate("settings/preferences/other")}
        >
          <Card.Meta
            avatar={<Icon name={OTHER_ICON_NAME} />}
            title={intl.formatMessage(labels.other)}
            description={intl.formatMessage(MESSAGES.other)}
          />
        </Card>
      </Flex>

      {(is_commercial || isAdmin) && (
        <>
          <Divider plain>
            <Icon name="money-check" /> {intl.formatMessage(labels.billing)}
          </Divider>
          <Flex {...FLEX_PROPS}>
            <Card
              {...HIGHLIGHTED_CARD_PROPS}
              onClick={() => handleNavigate("settings/subscriptions")}
            >
              <Card.Meta
                avatar={<Icon name="calendar" />}
                title={intl.formatMessage(labels.subscriptions)}
                description={intl.formatMessage(MESSAGES.subscriptions)}
              />
            </Card>
            <Card
              {...HIGHLIGHTED_CARD_PROPS}
              onClick={() => handleNavigate("settings/licenses")}
            >
              <Card.Meta
                avatar={<Icon name="key" />}
                title={intl.formatMessage(labels.licenses)}
                description={intl.formatMessage(MESSAGES.licenses)}
              />
            </Card>
            <Card
              {...HIGHLIGHTED_CARD_PROPS}
              onClick={() => handleNavigate("settings/store")}
            >
              <Card.Meta
                avatar={<Icon name="shopping-cart" />}
                title="Store"
                description={intl.formatMessage(MESSAGES.store)}
              />
            </Card>
            <Card
              {...CARD_PROPS}
              onClick={() => handleNavigate("settings/vouchers")}
            >
              <Card.Meta
                avatar={<Icon name="gift" />}
                title="Voucher Center"
                description={intl.formatMessage(MESSAGES.vouchers)}
              />
            </Card>
            {is_commercial && (
              <>
                <Card
                  {...CARD_PROPS}
                  onClick={() => handleNavigate("settings/payg")}
                >
                  <Card.Meta
                    avatar={<Icon name="line-chart" />}
                    title={intl.formatMessage(labels.pay_as_you_go)}
                    description={intl.formatMessage(MESSAGES.payg)}
                  />
                </Card>
                <Card
                  {...CARD_PROPS}
                  onClick={() => handleNavigate("settings/purchases")}
                >
                  <Card.Meta
                    avatar={<Icon name="money-check" />}
                    title={intl.formatMessage(labels.purchases)}
                    description={intl.formatMessage(MESSAGES.purchases)}
                  />
                </Card>
                <Card
                  {...CARD_PROPS}
                  onClick={() => handleNavigate("settings/payments")}
                >
                  <Card.Meta
                    avatar={<Icon name="credit-card" />}
                    title={intl.formatMessage(labels.payments)}
                    description={intl.formatMessage(MESSAGES.payments)}
                  />
                </Card>
                <Card
                  {...CARD_PROPS}
                  onClick={() => handleNavigate("settings/statements")}
                >
                  <Card.Meta
                    avatar={<Icon name="calendar-week" />}
                    title={intl.formatMessage(labels.statements)}
                    description={intl.formatMessage(MESSAGES.statements)}
                  />
                </Card>
              </>
            )}
          </Flex>
        </>
      )}

      {!lite && (
        <>
          <Divider plain>
            <Icon name="files" /> {intl.formatMessage(labels.files)}
          </Divider>
          <Flex {...FLEX_PROPS}>
            <Card
              {...CARD_PROPS}
              onClick={() => handleNavigate("settings/public-files")}
            >
              <Card.Meta
                avatar={<Icon name="share-square" />}
                title={intl.formatMessage(labels.published_files)}
                description={intl.formatMessage(MESSAGES.files)}
              />
            </Card>
          </Flex>
        </>
      )}

      {zendesk && (
        <>
          <Divider plain>
            <Icon name="medkit" /> {intl.formatMessage(labels.support)}
          </Divider>
          <Flex {...FLEX_PROPS}>
            <Card
              {...CARD_PROPS}
              onClick={() => handleNavigate("settings/support")}
            >
              <Card.Meta
                avatar={<Icon name="medkit" />}
                title={intl.formatMessage(labels.support)}
                description={intl.formatMessage(MESSAGES.support)}
              />
            </Card>
          </Flex>
        </>
      )}
    </div>
  );
}
