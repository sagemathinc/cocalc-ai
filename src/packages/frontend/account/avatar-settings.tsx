/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Form, Space } from "antd";
import { useIntl } from "react-intl";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { ColorPicker } from "@cocalc/frontend/colorpicker";
import { Loading, SettingBox } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { Avatar } from "./avatar/avatar";
import { ProfileImageSelector, setProfile } from "./profile-image";

interface Props {
  email_address?: string;
  // first_name?: string;
  // last_name?: string;
}

export function AvatarSettings({ email_address }: Props) {
  const intl = useIntl();

  // const [show_instructions, set_show_instructions] = useState<boolean>(false);

  const account_id: string = useTypedRedux("account", "account_id");
  const profile = useTypedRedux("account", "profile");

  function onColorChange(value: string) {
    setProfile({
      account_id,
      profile: { color: value },
    });
  }

  if (account_id == null || profile == null) {
    return <Loading />;
  }

  return (
    <SettingBox
      title={
        <Space>
          <Avatar account_id={account_id} size={48} />
          Avatar
        </Space>
      }
    >
      <Form layout="vertical">
        <Form.Item label={intl.formatMessage(labels.color)}>
          <ColorPicker
            color={profile?.get("color")}
            justifyContent={"flex-start"}
            onChange={onColorChange}
          />
        </Form.Item>
        <Form.Item label="Style">
          <ProfileImageSelector
            account_id={account_id}
            email_address={email_address}
            profile={profile}
          />
        </Form.Item>
      </Form>
    </SettingBox>
  );
}
