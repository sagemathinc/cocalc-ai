/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Tag } from "antd";
import type {
  Host,
  HostPressureState,
  HostPressureZone,
} from "@cocalc/conat/hub/api/hosts";
import { Tooltip } from "@cocalc/frontend/components";

const PRESSURE_ORDER: Record<HostPressureZone, number> = {
  normal: 0,
  observe: 1,
  pressure: 2,
  emergency: 3,
};

const PRESSURE_COLOR: Partial<Record<HostPressureZone, string>> = {
  observe: "gold",
  pressure: "orange",
  emergency: "red",
};

const PRESSURE_LABEL: Partial<Record<HostPressureZone, string>> = {
  observe: "Observe",
  pressure: "Pressure",
  emergency: "Emergency",
};

export function hostPressureRank(host?: Pick<Host, "pressure">): number {
  const zone = host?.pressure?.zone;
  if (!zone) return PRESSURE_ORDER.normal;
  return PRESSURE_ORDER[zone] ?? PRESSURE_ORDER.normal;
}

export function HostPressureTag({
  pressure,
}: {
  pressure?: HostPressureState;
}) {
  const zone = pressure?.zone;
  if (!zone || zone === "normal") return null;
  const label = PRESSURE_LABEL[zone] ?? zone;
  const tag = <Tag color={PRESSURE_COLOR[zone]}>{label}</Tag>;
  if (!pressure?.reason) return tag;
  return <Tooltip title={pressure.reason}>{tag}</Tooltip>;
}
