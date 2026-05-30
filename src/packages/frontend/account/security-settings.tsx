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

import { DeleteAccountButton } from "./delete-account";
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
            confirm={() =>
              runFreshAuthAction(async () => {
                await actions().delete_account();
              })
            }
            requiredText={userName}
          />
        </Flex>
        <TwoFactorAuthSetting showHeader={false} />
      </Flex>
      <FreshAuthModal {...freshAuthModalProps} />
    </SettingBox>
  );
}
