/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Select } from "antd";
import { COLORS } from "@cocalc/util/theme";
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
      showSearch
      optionFilterProp="label"
      filterOption={(input, option) =>
        String(option?.label ?? "")
          .toLowerCase()
          .includes(input.trim().toLowerCase())
      }
      popupMatchSelectWidth={false}
      optionRender={(option: any) => {
        const data = option.data as HostFieldOption | undefined;
        const mainLabel =
          data?.mainLabel ?? data?.selectionLabel ?? data?.label;
        const detail = data?.priceLabel ?? data?.stateLabel;
        if (!detail) {
          return <span>{mainLabel}</span>;
        }
        return (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              gap: 16,
              width: "100%",
            }}
          >
            <span>{mainLabel}</span>
            <span
              style={{
                color: data?.priceLabel ? COLORS.GRAY_D : COLORS.GRAY_M,
                fontVariantNumeric: "tabular-nums",
                textAlign: "right",
                whiteSpace: "nowrap",
              }}
            >
              {detail}
            </span>
          </div>
        );
      }}
      labelRender={(item: any) => {
        const selected = options?.find(
          (option) => option.value === item?.value,
        );
        return selected?.selectionLabel ?? selected?.label ?? item?.label;
      }}
    />
  );
}
