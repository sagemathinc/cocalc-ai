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

type HostOptionGroup = {
  label: string;
  options: HostFieldOption[];
};

function isUnavailableHostOption(option: HostFieldOption): boolean {
  return !!option.stateLabel || option.disabled === true;
}

export function groupHostOptions(
  options?: HostFieldOption[],
): HostFieldOption[] | HostOptionGroup[] | undefined {
  if (!options?.length) return options;
  const available = options.filter(
    (option) => !isUnavailableHostOption(option),
  );
  const unavailable = options.filter((option) =>
    isUnavailableHostOption(option),
  );
  if (!available.length || !unavailable.length) {
    return options;
  }
  return [
    { label: "Available", options: available },
    { label: "Unavailable in this region", options: unavailable },
  ];
}

export function HostOptionsSelect({
  options,
  disabled,
  placeholder,
  value,
  onChange,
  size,
}: HostOptionsSelectProps) {
  const groupedOptions = groupHostOptions(options);
  return (
    <Select
      options={groupedOptions as any}
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
