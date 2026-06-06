/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import gravatarUrl from "./gravatar-url";
import { Button, Flex, Space, Typography } from "antd";
import type { ReactNode } from "react";
import { redux, Rendered, useState } from "@cocalc/frontend/app-framework";
import { ErrorDisplay, Loading, Tooltip } from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import UploadProfileImage from "./upload-profile-image";

interface ProfileImageSelectorProps {
  account_id: string;
  avatarPreview: ReactNode;
  colorAction: ReactNode;
  email_address: string | undefined;
  onImageChange: (src: string) => void;
}

export async function setProfile({ account_id, profile }) {
  if (redux.getStore("account")?.get("account_id") === account_id) {
    await redux.getTable("account").set({ profile });
    return;
  }
  await webapp_client.async_query({
    query: {
      accounts: { account_id, profile },
    },
  });
}

export function ProfileImageSelector({
  account_id,
  avatarPreview,
  colorAction,
  email_address,
  onImageChange,
}: ProfileImageSelectorProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function setImage(src: string): Promise<void> {
    onImageChange(src);
    setIsLoading(true);
    setError(undefined);
    try {
      await setProfile({
        account_id,
        profile: { image: src },
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setIsLoading(false);
    }
  }

  function renderGravatarButton(): Rendered {
    if (!email_address) {
      return;
    }
    return (
      <Tooltip title="Use the Gravatar image associated with your email address.">
        <Button onClick={() => setImage(gravatarUrl(email_address))}>
          Use Gravatar
        </Button>
      </Tooltip>
    );
  }

  if (isLoading) {
    return (
      <Flex align="center" gap="middle" wrap>
        {avatarPreview}
        <Space>
          Saving...
          <Loading />
        </Space>
      </Flex>
    );
  }

  return (
    <Flex align="center" gap="middle" wrap>
      <UploadProfileImage
        dropTarget
        onChange={(data) => setImage(data)}
        tooltip="Drop an image here, or click to upload and crop."
      >
        {avatarPreview}
      </UploadProfileImage>
      <Space vertical>
        <Typography.Text>
          Avatar shown to collaborators and in account menus.
        </Typography.Text>
        {error ? (
          <ErrorDisplay error={error} onClose={() => setError(undefined)} />
        ) : undefined}
        <Space wrap>
          <UploadProfileImage onChange={(data) => setImage(data)}>
            Upload
          </UploadProfileImage>
          <Tooltip title="Use the first letter of your first name as your avatar.">
            <Button onClick={() => setImage("")}>Use default</Button>
          </Tooltip>
          {colorAction}
          {renderGravatarButton()}
        </Space>
      </Space>
    </Flex>
  );
}
