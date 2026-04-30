/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { CheckCircleTwoTone, CloseCircleTwoTone } from "@ant-design/icons";
import { React } from "@cocalc/frontend/app-framework";
import { COLORS } from "@cocalc/util/theme";
import { Progress } from "antd";

export const PercentBar: React.FC<{
  percent?: number;
  percent2?: number; // part of the main bar, should be < percent
  format?: (pct?: number) => React.ReactNode;
}> = ({ percent, percent2, format }) => {
  if (percent == null) return null;

  function props() {
    if (typeof percent2 === "number") {
      return { success: { percent: percent2, strokeColor: COLORS.GRAY_D } };
    }
  }

  return (
    <Progress
      percent={percent}
      strokeColor={COLORS.GRAY_L}
      size={"small"}
      format={format}
      status={"normal"}
      {...props()}
    />
  );
};

export function renderBoolean(val, running: boolean) {
  const color = (c) => (running ? c : COLORS.GRAY_L);

  if (val) {
    return <CheckCircleTwoTone twoToneColor={color(COLORS.ANTD_GREEN)} />;
  } else {
    return <CloseCircleTwoTone twoToneColor={color(COLORS.ANTD_RED)} />;
  }
}
