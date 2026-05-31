/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { type CSSProperties, useEffect, useState } from "react";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { ColorButton } from "@cocalc/frontend/components/color-picker";
import { Loading, SettingBox } from "@cocalc/frontend/components";
import { DEFAULT_COLOR } from "@cocalc/frontend/users/store";
import { avatar_fontcolor } from "./avatar/font-color";
import { ProfileImageSelector, setProfile } from "./profile-image";

interface Props {
  email_address?: string;
}

const AVATAR_PREVIEW_SIZE = 96;

function getAvatarLetter(firstName?: string): string {
  return firstName?.trim()?.toUpperCase()[0] ?? "?";
}

function AvatarPreview({
  color,
  firstName,
  image,
  size = AVATAR_PREVIEW_SIZE,
}: {
  color: string;
  firstName?: string;
  image?: string;
  size?: number;
}) {
  const style: CSSProperties = {
    alignItems: "center",
    backgroundColor: color,
    borderRadius: "50%",
    color: avatar_fontcolor(color),
    cursor: "pointer",
    display: "inline-flex",
    fontFamily: "sans-serif",
    fontSize: 0.7 * size,
    height: size,
    justifyContent: "center",
    lineHeight: `${size}px`,
    width: size,
  };
  if (image) {
    return (
      <img
        src={image}
        style={{
          borderRadius: "50%",
          height: size,
          cursor: "pointer",
          objectFit: "cover",
          width: size,
        }}
      />
    );
  }
  return <span style={style}>{getAvatarLetter(firstName)}</span>;
}

export function AvatarSettings({ email_address }: Props) {
  const account_id: string = useTypedRedux("account", "account_id");
  const firstName = useTypedRedux("account", "first_name");
  const profile = useTypedRedux("account", "profile");
  const profileColor = profile?.get("color") ?? DEFAULT_COLOR;
  const profileImage = profile?.get("image");
  const [previewColor, setPreviewColor] = useState<string>(profileColor);
  const [previewImage, setPreviewImage] = useState<string | undefined>(
    profileImage,
  );

  useEffect(() => {
    setPreviewColor(profileColor);
    setPreviewImage(profileImage);
  }, [profileColor, profileImage]);

  async function onColorChange(value: string): Promise<void> {
    setPreviewColor(value);
    await setProfile({
      account_id,
      profile: { color: value },
    });
  }

  if (account_id == null || profile == null) {
    return <Loading />;
  }

  return (
    <SettingBox title="Avatar">
      <ProfileImageSelector
        account_id={account_id}
        avatarPreview={
          <AvatarPreview
            color={previewColor}
            firstName={firstName}
            image={previewImage}
          />
        }
        colorAction={
          <ColorButton
            color={previewColor}
            onChange={onColorChange}
            title="Select avatar color"
            tooltip="Pick the color for your default avatar, name, and collaboration labels."
          >
            Color
          </ColorButton>
        }
        email_address={email_address}
        onImageChange={(src) => setPreviewImage(src || undefined)}
      />
    </SettingBox>
  );
}
