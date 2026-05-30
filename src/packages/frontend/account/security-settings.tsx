/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Flex } from "antd";
import { useIntl } from "react-intl";

import { redux, useState } from "@cocalc/frontend/app-framework";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { Icon, SettingBox } from "@cocalc/frontend/components";
import { lite } from "@cocalc/frontend/lite";

import { DeleteAccountConfirmation } from "./delete-account";
import { PasswordSetting } from "./settings/password-setting";
import TwoFactorAuthSetting from "./settings/two-factor-auth";
import { ugly_error } from "./util";

interface Props {
  email_address?: string;
  first_name?: string;
  last_name?: string;
}

export function SecuritySettings({
  email_address,
  first_name,
  last_name,
}: Readonly<Props>) {
  const intl = useIntl();
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: ugly_error,
  });

  if (lite) {
    return null;
  }

  const actions = () => redux.getActions("account");
  const userName = `${first_name ?? ""} ${last_name ?? ""}`.trim();

  return (
    <SettingBox title="Security" icon="lock">
      <Flex justify="space-between" gap="small" wrap>
        <div style={{ flex: 1 }}>
          {email_address ? (
            <PasswordSetting
              runFreshAuthAction={runFreshAuthAction}
              showLabel={false}
            />
          ) : undefined}
        </div>
        <Button
          danger
          disabled={showDeleteConfirmation}
          onClick={() => setShowDeleteConfirmation(true)}
        >
          <Icon name="trash" />{" "}
          {intl.formatMessage({
            id: "account.delete-account.button",
            defaultMessage: "Delete Account",
          })}
          ...
        </Button>
      </Flex>
      {showDeleteConfirmation ? (
        <DeleteAccountConfirmation
          confirm_click={() =>
            runFreshAuthAction(async () => {
              await actions().delete_account();
            })
          }
          cancel_click={() => setShowDeleteConfirmation(false)}
          required_text={userName}
        />
      ) : undefined}
      <TwoFactorAuthSetting showHeader={false} />
      <FreshAuthModal {...freshAuthModalProps} />
    </SettingBox>
  );
}
