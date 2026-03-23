/*
Button to get to the settings page. Currently used by lite mode only.
*/

import type { CSSProperties, ReactNode } from "react";
import { Icon } from "@cocalc/frontend/components";
import { Button } from "antd";
import { redux } from "@cocalc/frontend/app-framework";

interface SettingsButtonProps {
  block?: boolean;
  className?: string;
  iconStyle?: CSSProperties;
  label?: ReactNode;
  style?: CSSProperties;
}

export default function SettingsButton({
  block,
  className,
  iconStyle,
  label,
  style,
}: Readonly<SettingsButtonProps>) {
  const icon = <Icon name="cog" style={iconStyle} />;
  return (
    <Button
      block={block}
      className={className}
      style={style ?? { margin: "2.5px 0 0 10px" }}
      type="text"
      onClick={() => {
        redux.getActions("page").set_active_tab("account");
      }}
    >
      {label == null ? icon : label}
    </Button>
  );
}
