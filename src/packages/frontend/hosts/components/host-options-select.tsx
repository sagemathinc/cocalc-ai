/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Select } from "antd";
import type { HostFieldOption } from "../providers/registry";

type HostOptionsSelectProps = {
  options?: HostFieldOption[];
  disabled?: boolean;
  placeholder?: string;
  value?: string;
  onChange?: (value: string) => void;
  size?: "small" | "middle" | "large";
};

export function HostOptionsSelect({
  options,
  disabled,
  placeholder,
  value,
  onChange,
  size,
}: HostOptionsSelectProps) {
  return (
    <Select
      options={options}
      disabled={disabled}
      placeholder={placeholder}
      value={value}
      onChange={onChange}
      size={size}
      popupMatchSelectWidth={false}
      labelRender={(item: any) => {
        const selected = options?.find(
          (option) => option.value === item?.value,
        );
        return selected?.selectionLabel ?? selected?.label ?? item?.label;
      }}
    />
  );
}
