/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Flex } from "antd";

import { redux } from "@cocalc/frontend/app-framework";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { SettingBox } from "@cocalc/frontend/components";
import { lite } from "@cocalc/frontend/lite";
import { displayNameFromAccount } from "@cocalc/util/accounts/display-name";

import { DeleteAccountButton } from "./delete-account";
import { PasswordSetting } from "./settings/password-setting";
import TwoFactorAuthSetting from "./settings/two-factor-auth";
import { ugly_error } from "./util";

interface Props {
  email_address?: string;
  display_name?: string;
  first_name?: string;
  last_name?: string;
}

export function SecuritySettings({
  email_address,
  display_name,
  first_name,
  last_name,
}: Readonly<Props>) {
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  if (lite) {
    return null;
  }

  const actions = () => redux.getActions("account");
  const userName = displayNameFromAccount({
    display_name,
    first_name,
    last_name,
  });

  return (
    <SettingBox title="Security" icon="lock">
      <Flex vertical gap="middle">
        <Flex align="flex-start" justify="space-between" gap="small" wrap>
          <Flex flex={1}>
            {email_address ? (
              <PasswordSetting
                runFreshAuthAction={runFreshAuthAction}
                showLabel={false}
              />
            ) : undefined}
          </Flex>
          <DeleteAccountButton
            confirm={async () => {
              try {
                await runFreshAuthAction(async () => {
                  await actions().delete_account();
                });
              } catch (err) {
                ugly_error(err);
              }
            }}
            requiredText={userName}
          />
        </Flex>
        <TwoFactorAuthSetting showHeader={false} />
      </Flex>
      <FreshAuthModal {...freshAuthModalProps} />
    </SettingBox>
  );
}
