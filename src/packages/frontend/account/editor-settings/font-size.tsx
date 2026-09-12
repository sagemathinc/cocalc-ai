/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { InputNumber } from "antd";
import { LabeledRow } from "@cocalc/frontend/components";
import { DEFAULT_FONT_SIZE } from "@cocalc/util/consts/ui";
import { useIntl } from "react-intl";

import { FONT_SIZE_LABEL } from "./labels";

interface Props {
  font_size: number;
  on_change: (name: string, value: number) => void;
}

export function EditorSettingsFontSize(props: Props) {
  const intl = useIntl();

  return (
    <LabeledRow
      label={intl.formatMessage(FONT_SIZE_LABEL)}
      className="cc-account-prefs-font-size"
    >
      <InputNumber
        aria-label={intl.formatMessage(FONT_SIZE_LABEL)}
        onChange={(n) => props.on_change("font_size", n ?? DEFAULT_FONT_SIZE)}
        min={5}
        max={32}
        value={props.font_size}
        suffix="px"
      />
    </LabeledRow>
  );
}
