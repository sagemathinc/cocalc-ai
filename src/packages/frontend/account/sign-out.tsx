/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import { Alert, Button, Checkbox, Flex, Popover, Space } from "antd";
import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Icon } from "@cocalc/frontend/components/icon";
import {
  React,
  Rendered,
  redux,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { labels } from "@cocalc/frontend/i18n";

interface Props {
  everywhere?: boolean;
  style?: React.CSSProperties;
  narrow?: boolean;
}

export const SignOut: React.FC<Props> = (props: Readonly<Props>) => {
  const { everywhere, style, narrow = false } = props;
  const [open, setOpen] = useState(false);
  const [signOutEverywhere, setSignOutEverywhere] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const signOutError = useTypedRedux("account", "sign_out_error");

  const intl = useIntl();
  const effectiveEverywhere = !!everywhere || signOutEverywhere;
  const accountActions = () => redux.getActions("account");

  function handleOpenChange(nextOpen: boolean): void {
    setOpen(nextOpen);
    if (!nextOpen) {
      setSignOutEverywhere(false);
      accountActions()?.setState({ sign_out_error: "" });
    }
  }

  async function sign_out(): Promise<void> {
    const account = accountActions();
    if (account != null) {
      setSigningOut(true);
      account.setState({ sign_out_error: "" });
      await account.sign_out(effectiveEverywhere);
      setSigningOut(false);
    }
  }

  function render_body(): Rendered {
    return (
      <span>
        <FormattedMessage
          id="account.sign_out.body.sign_out"
          description={"Sign out button, if signed in"}
          defaultMessage={`Sign out{everywhere, select, true { everywhere} other {}}...`}
          values={{ everywhere }}
        />
      </span>
    );
  }

  // I think not using reduxProps is fine for this, since it's only rendered once
  // you are signed in, and falling back to "your account" isn't bad.
  const store = redux.getStore("account");
  const account: string = store.get("email_address") ?? "your account";

  function render_title(): Rendered {
    if (everywhere) {
      return (
        <FormattedMessage
          id="account.sign-out.popover.everywhere-title"
          defaultMessage="Sign out {account} everywhere?"
          values={{ account }}
        />
      );
    }
    return (
      <FormattedMessage
        id="account.sign-out.popover.title"
        defaultMessage="Sign out {account} on this browser?"
        values={{ account }}
      />
    );
  }

  function render_content(): React.JSX.Element {
    return (
      <Space vertical>
        {signOutError && <Alert type="error" message={signOutError} />}
        {!everywhere && (
          <Checkbox
            checked={signOutEverywhere}
            onChange={(event) => setSignOutEverywhere(event.target.checked)}
          >
            <FormattedMessage
              id="account.sign-out.popover.everywhere-checkbox"
              defaultMessage="Also sign out on other browsers and devices"
            />
          </Checkbox>
        )}
        <Flex justify="space-between" gap="small">
          <Button disabled={signingOut} onClick={() => handleOpenChange(false)}>
            {intl.formatMessage(labels.cancel)}
          </Button>
          <Button
            danger={effectiveEverywhere}
            loading={signingOut}
            onClick={sign_out}
            type="primary"
          >
            {intl.formatMessage(
              {
                id: "account.sign-out.popover.confirm",
                defaultMessage: `Sign out{everywhere, select, true { everywhere} other {}}`,
              },
              { everywhere: effectiveEverywhere },
            )}
          </Button>
        </Flex>
      </Space>
    );
  }

  return (
    <Popover
      content={render_content()}
      onOpenChange={handleOpenChange}
      open={open}
      placement="bottomRight"
      title={render_title()}
      trigger="click"
    >
      {/* NOTE: weirdly darkreader breaks when we use the antd LogoutOutlined icon!? */}
      <Button style={style}>
        <Icon name="sign-in" />{" "}
        {!narrow || everywhere ? render_body() : undefined}
      </Button>
    </Popover>
  );
};
