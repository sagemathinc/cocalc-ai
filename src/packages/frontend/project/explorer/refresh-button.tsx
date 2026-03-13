/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Popover, Switch } from "antd";
import { useEffect, useState } from "react";
import { useIntl } from "react-intl";

import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { COLORS } from "@cocalc/util/theme";

interface Props {
  onClick?: () => void;
}

interface AutoUpdateToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function AutoUpdateSwitch({ checked, onChange }: AutoUpdateToggleProps) {
  const [value, setValue] = useState(checked);

  useEffect(() => {
    setValue(checked);
  }, [checked]);

  return (
    <span
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <Switch
        size="small"
        checked={value}
        onClick={(_checked, e) => e.stopPropagation()}
        onChange={(next, e) => {
          e.stopPropagation();
          setValue(next);
          onChange(next);
        }}
      />
    </span>
  );
}

export function AutoUpdateToggle({ checked, onChange }: AutoUpdateToggleProps) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "1px 8px",
        borderRadius: 999,
        background: checked ? COLORS.BLUE_LLLL : COLORS.GRAY_LLL,
        color: COLORS.GRAY_D,
        whiteSpace: "nowrap",
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <span>Auto updates</span>
      <AutoUpdateSwitch checked={checked} onChange={onChange} />
    </span>
  );
}

export function RefreshButton({ onClick }: Props) {
  const intl = useIntl();
  const autoUpdateListing = !!useTypedRedux("account", "other_settings")?.get(
    "auto_update_file_listing",
  );

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
      }}
    >
      <Button
        type="text"
        size="small"
        style={{
          background: COLORS.YELL_LLL,
          color: "black",
          borderRadius: 4,
          whiteSpace: "nowrap",
          marginLeft: 6,
        }}
        icon={<Icon name="sync-alt" />}
        onClick={onClick}
      >
        {intl.formatMessage(labels.refresh)}
      </Button>
      <Popover
        trigger="click"
        title={intl.formatMessage(labels.refresh)}
        content={
          <div style={{ maxWidth: 260 }}>
            <div style={{ marginBottom: 8 }}>
              Apply pending filesystem changes to this listing.
            </div>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                margin: 0,
              }}
            >
              <span>Automatic updates</span>
              <AutoUpdateSwitch
                checked={autoUpdateListing}
                onChange={(checked) =>
                  redux
                    .getActions("account")
                    ?.set_other_settings("auto_update_file_listing", checked)
                }
              />
            </label>
          </div>
        }
      >
        <Button
          type="text"
          size="small"
          style={{
            paddingInline: 6,
            color: COLORS.GRAY_D,
          }}
          icon={<Icon name="question-circle" />}
        />
      </Popover>
    </span>
  );
}
