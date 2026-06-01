/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Checkbox,
  Divider,
  Flex,
  Space,
  Typography,
} from "antd";
import { List, Map } from "immutable";
import { join } from "path";
import { FormattedMessage, useIntl } from "react-intl";
import {
  Rendered,
  TypedMap,
  redux,
  useState,
} from "@cocalc/frontend/app-framework";
import {
  Icon,
  LabeledRow,
  SettingBox,
  TimeAgo,
} from "@cocalc/frontend/components";
import { SiteName } from "@cocalc/frontend/customize";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { labels } from "@cocalc/frontend/i18n";
import { CancelText } from "@cocalc/frontend/i18n/components";
import { open_new_tab } from "@cocalc/frontend/misc/open-browser-tab";
import {
  PassportStrategyIcon,
  strategy2display,
} from "@cocalc/frontend/passports";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { keys, startswith } from "@cocalc/util/misc";
import { PassportStrategyFrontend } from "@cocalc/util/types/passport-types";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { set_account_table, ugly_error } from "../util";
import { EmailAddressSetting } from "./email-address-setting";
import { EmailVerification } from "./email-verification";
import { TextSetting } from "./text-setting";
import { lite } from "@cocalc/frontend/lite";

type ImmutablePassportStrategy = TypedMap<PassportStrategyFrontend>;

interface Props {
  account_id?: string;
  first_name?: string;
  last_name?: string;
  unlisted?: boolean;
  email_address?: string;
  email_address_verified?: Map<string, any>;
  passports?: Map<string, any>;
  email_enabled?: boolean;
  verify_emails?: boolean;
  created?: Date;
  strategies?: List<ImmutablePassportStrategy>;
}

export function AccountSettings(props: Readonly<Props>) {
  const intl = useIntl();

  const [add_strategy_link, set_add_strategy_link] = useState<
    string | undefined
  >(undefined);
  const [remove_strategy_button, set_remove_strategy_button] = useState<
    string | undefined
  >(undefined);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: ugly_error,
  });

  const actions = () => redux.getActions("account");

  function handle_change(evt, field) {
    actions().setState({ [field]: evt.target.value });
  }

  function save_change(evt, field: string): void {
    const { value } = evt.target;
    set_account_table({ [field]: value });
  }

  function get_strategy(name: string): ImmutablePassportStrategy | undefined {
    if (props.strategies == null) return undefined;
    return props.strategies.find((val) => val.get("name") == name);
  }

  function render_add_strategy_link(): Rendered {
    if (!add_strategy_link) {
      return;
    }
    const strategy_name = add_strategy_link;
    const strategy = get_strategy(strategy_name);
    if (strategy == null) return;
    const strategy_js = strategy.toJS();
    const name = strategy2display(strategy_js);
    const href = join(appBasePath, "auth", add_strategy_link);
    return (
      <Card size="small">
        <Flex vertical gap="middle">
          <Typography.Title level={4}>
            <PassportStrategyIcon strategy={strategy_js} /> {name}
          </Typography.Title>
          <Typography.Paragraph>
            Link to your {name} account, so you can use {name} to login to your{" "}
            <SiteName /> account.
          </Typography.Paragraph>
          <Space wrap>
            <Button
              href={href}
              target="_blank"
              onClick={() => {
                set_add_strategy_link(undefined);
              }}
            >
              <Icon name="external-link" /> Link My {name} Account
            </Button>
            <Button onClick={() => set_add_strategy_link(undefined)}>
              <CancelText />
            </Button>
          </Space>
        </Flex>
      </Card>
    );
  }

  async function remove_strategy_click(): Promise<void> {
    const strategy = remove_strategy_button;
    set_remove_strategy_button(undefined);
    set_add_strategy_link(undefined);
    if (strategy == null) return;
    const obj = props.passports?.toJS() ?? {};
    let id: string | undefined = undefined;
    for (const k in obj) {
      if (startswith(k, strategy)) {
        id = k.split("-")[1];
        break;
      }
    }
    if (!id) {
      return;
    }
    try {
      await runFreshAuthAction(async () => {
        await webapp_client.account_client.unlink_passport(strategy, id);
      });
      // console.log("ret:", x);
    } catch (err) {
      ugly_error(err);
    }
  }

  function render_remove_strategy_button(): Rendered {
    if (!remove_strategy_button) {
      return;
    }
    const strategy_name = remove_strategy_button;
    const strategy = get_strategy(strategy_name);
    if (strategy == null) return;
    const strategy_js = strategy.toJS();
    const name = strategy2display(strategy_js);
    if ((props.passports?.size ?? 0) <= 1 && !props.email_address) {
      return (
        <Alert
          type="warning"
          title="Add another sign-in method first"
          description={
            <>
              You must set an email address above or add another login method
              before you can disable login to your <SiteName /> account using
              your {name} account. Otherwise you would completely lose access to
              your account!
            </>
          }
        />
      );
      // TODO: flesh out the case where the UI prevents a user from unlinking an exclusive sso strategy
      // Right now, the backend blocks
    } else if (false) {
      return (
        <Alert
          type="warning"
          title={`You are not allowed to remove ${name}.`}
        />
      );
    } else {
      return (
        <Card size="small">
          <Flex vertical gap="middle">
            <Typography.Title level={4}>
              <PassportStrategyIcon strategy={strategy_js} /> {name}
            </Typography.Title>
            <Typography.Paragraph>
              Your <SiteName /> account is linked to your {name} account, so you
              can login using it.
            </Typography.Paragraph>
            <Typography.Paragraph>
              If you unlink your {name} account, you will no longer be able to
              use this account to log into <SiteName />.
            </Typography.Paragraph>
            <Space wrap>
              <Button danger onClick={remove_strategy_click}>
                <Icon name="unlink" /> Unlink my {name} account
              </Button>
              <Button onClick={() => set_remove_strategy_button(undefined)}>
                <CancelText />
              </Button>
            </Space>
          </Flex>
        </Card>
      );
    }
  }

  function render_strategy(
    strategy: ImmutablePassportStrategy,
    account_passports: string[],
  ): Rendered {
    if (strategy.get("name") !== "email") {
      const is_configured = account_passports.includes(strategy.get("name"));
      const strategy_js = strategy.toJS();
      const btn = (
        <Button
          onClick={() => {
            if (is_configured) {
              set_remove_strategy_button(strategy.get("name"));
              set_add_strategy_link(undefined);
            } else {
              set_add_strategy_link(strategy.get("name"));
              set_remove_strategy_button(undefined);
            }
          }}
          key={strategy.get("name")}
          type={is_configured ? "primary" : "default"}
        >
          <PassportStrategyIcon strategy={strategy_js} small={true} />{" "}
          {strategy2display(strategy_js)}
        </Button>
      );
      return btn;
    }
  }

  function get_account_passport_names(): string[] {
    return keys(props.passports?.toJS() ?? {}).map((x) =>
      x.slice(0, x.indexOf("-")),
    );
  }

  function render_linked_external_accounts(): Rendered {
    if (props.strategies == null || props.strategies.size <= 1 || lite) {
      // not configured by server
      return;
    }
    const account_passports: string[] = get_account_passport_names();

    const linked: List<ImmutablePassportStrategy> = props.strategies.filter(
      (strategy) => {
        const name = strategy?.get("name");
        return name !== "email" && account_passports.includes(name);
      },
    );
    if (linked.size === 0) return;

    const btns = linked
      .map((strategy) => render_strategy(strategy, account_passports))
      .toArray();
    return (
      <Flex vertical gap="small">
        <Divider titlePlacement="start" plain>
          {intl.formatMessage({
            id: "account.settings.sso.account_is_linked",
            defaultMessage: "Your account is linked with (click to unlink)",
          })}
        </Divider>
        <Space wrap>{btns}</Space>
        {render_remove_strategy_button()}
      </Flex>
    );
  }

  function render_available_to_link(): Rendered {
    if (props.strategies == null || props.strategies.size <= 1 || lite) {
      // not configured by server yet, or nothing but email
      return;
    }
    const account_passports: string[] = get_account_passport_names();

    let any_hidden = false;
    const not_linked: List<ImmutablePassportStrategy> = props.strategies.filter(
      (strategy) => {
        const name = strategy.get("name");
        // skip the email strategy, we don't use it
        if (name === "email") return false;
        // filter those which are already linked
        if (account_passports.includes(name)) return false;
        // do not show the non-public ones, unless they shouldn't be hidden
        if (
          !strategy.get("public", true) &&
          !strategy.get("do_not_hide", false)
        ) {
          any_hidden = true;
          return false;
        }
        return true;
      },
    );
    if (any_hidden === false && not_linked.size === 0) return;

    const heading = intl.formatMessage({
      id: "account.settings.sso.link_your_account",
      defaultMessage: "Click to link your account",
    });

    const btns = not_linked
      .map((strategy) => render_strategy(strategy, account_passports))
      .toArray();

    // add an extra button to link to the non public ones, which aren't shown
    if (any_hidden) {
      btns.push(
        <Button
          key="sso"
          onClick={() => open_new_tab(join(appBasePath, "sso"))}
          type="primary"
        >
          Other SSO
        </Button>,
      );
    }
    return (
      <Flex vertical gap="small">
        <Divider titlePlacement="start" plain>
          {heading}
        </Divider>
        <Space wrap>{btns}</Space>
        {render_add_strategy_link()}
      </Flex>
    );
  }

  function render_name(): Rendered {
    return (
      <>
        <TextSetting
          label={intl.formatMessage(labels.account_first_name)}
          value={props.first_name}
          onChange={(e) => handle_change(e, "first_name")}
          onBlur={(e) => save_change(e, "first_name")}
          onPressEnter={(e) => save_change(e, "first_name")}
          maxLength={254}
        />
        <TextSetting
          label={intl.formatMessage(labels.account_last_name)}
          value={props.last_name}
          onChange={(e) => handle_change(e, "last_name")}
          onBlur={(e) => save_change(e, "last_name")}
          onPressEnter={(e) => save_change(e, "last_name")}
          maxLength={254}
        />
      </>
    );
  }

  function render_account_id(): Rendered {
    if (!props.account_id || lite) {
      return;
    }
    return (
      <LabeledRow label="Account ID">
        <Typography.Text code copyable={{ text: props.account_id }}>
          {props.account_id}
        </Typography.Text>
      </LabeledRow>
    );
  }

  function render_created(): Rendered {
    if (!props.created) {
      return;
    }
    return (
      <LabeledRow
        label={
          <FormattedMessage
            id="account.settings.created.label"
            defaultMessage={"Created"}
          />
        }
      >
        <TimeAgo date={props.created} />
      </LabeledRow>
    );
  }

  function render_email_address(): Rendered {
    if (!props.account_id || lite) {
      return; // makes no sense to change email if there is no account
    }
    return (
      <EmailAddressSetting
        email_address={props.email_address}
        verify_emails={props.verify_emails}
        runFreshAuthAction={runFreshAuthAction}
      />
    );
  }

  function render_unlisted(): Rendered {
    if (!props.account_id || lite) {
      return; // makes no sense to change unlisted status if there is no account
    }
    return (
      <Checkbox
        checked={props.unlisted}
        onChange={(e) =>
          actions().set_account_table({ unlisted: e.target.checked })
        }
      >
        <FormattedMessage
          id="account.settings.unlisted.public_discovery_label"
          defaultMessage={
            "Hide my account from public collaborator lists and broad name searches"
          }
        />
      </Checkbox>
    );
  }

  function render_email_verification(): Rendered {
    if (props.email_enabled && props.verify_emails) {
      return (
        <EmailVerification
          email_address={props.email_address}
          email_address_verified={props.email_address_verified}
        />
      );
    }
  }

  return (
    <SettingBox title={intl.formatMessage(labels.account)} icon="address-card">
      <Space vertical>
        {render_account_id()}
        {render_name()}
        {render_email_address()}
        {render_unlisted()}
        {render_email_verification()}
        {render_created()}
        {render_linked_external_accounts()}
        {render_available_to_link()}
      </Space>
      <FreshAuthModal {...freshAuthModalProps} />
    </SettingBox>
  );
}
