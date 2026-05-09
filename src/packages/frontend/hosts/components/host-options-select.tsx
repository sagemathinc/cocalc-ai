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

export type MachineTypeSortMode = "type" | "price" | "cpu" | "value";

export function getMachineTypeSortOptions(
  showBenchmarks: boolean,
): Array<{ label: string; value: MachineTypeSortMode }> {
  return showBenchmarks
    ? [
        { label: "Type", value: "type" },
        { label: "Price", value: "price" },
        { label: "CPU", value: "cpu" },
        { label: "Value", value: "value" },
      ]
    : [
        { label: "Type", value: "type" },
        { label: "Price", value: "price" },
      ];
}

function isUnavailableHostOption(option: HostFieldOption): boolean {
  return !!option.stateLabel || option.disabled === true;
}

function hostOptionTypeLabel(option: HostFieldOption): string {
  return (
    option.selectionLabel ??
    option.mainLabel ??
    option.label ??
    option.value
  ).toLowerCase();
}

function compareHostOptionsByType(
  left: HostFieldOption,
  right: HostFieldOption,
): number {
  return hostOptionTypeLabel(left).localeCompare(
    hostOptionTypeLabel(right),
    undefined,
    {
      numeric: true,
      sensitivity: "base",
    },
  );
}

function compareHostOptionsByPrice(
  left: HostFieldOption,
  right: HostFieldOption,
): number {
  const leftRate = left.hourlyRate;
  const rightRate = right.hourlyRate;
  const leftHasRate =
    typeof leftRate === "number" && Number.isFinite(leftRate) && leftRate >= 0;
  const rightHasRate =
    typeof rightRate === "number" &&
    Number.isFinite(rightRate) &&
    rightRate >= 0;
  if (leftHasRate && rightHasRate && leftRate !== rightRate) {
    return leftRate - rightRate;
  }
  if (leftHasRate !== rightHasRate) {
    return leftHasRate ? -1 : 1;
  }
  return compareHostOptionsByType(left, right);
}

function compareOptionalDescending(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  const leftHasValue =
    typeof left === "number" && Number.isFinite(left) && left > 0;
  const rightHasValue =
    typeof right === "number" && Number.isFinite(right) && right > 0;
  if (leftHasValue && rightHasValue) {
    if (left === right) return 0;
    return right - left;
  }
  if (leftHasValue !== rightHasValue) {
    return leftHasValue ? -1 : 1;
  }
  return undefined;
}

function compareHostOptionsByCpu(
  left: HostFieldOption,
  right: HostFieldOption,
): number {
  const benchmarkOrder = compareOptionalDescending(
    left.benchmarkCpuScore,
    right.benchmarkCpuScore,
  );
  if (benchmarkOrder != null && benchmarkOrder !== 0) {
    return benchmarkOrder;
  }
  return compareHostOptionsByType(left, right);
}

function compareHostOptionsByValue(
  left: HostFieldOption,
  right: HostFieldOption,
): number {
  const benchmarkOrder = compareOptionalDescending(
    left.benchmarkValueScore,
    right.benchmarkValueScore,
  );
  if (benchmarkOrder != null && benchmarkOrder !== 0) {
    return benchmarkOrder;
  }
  return compareHostOptionsByPrice(left, right);
}

export function sortMachineTypeOptions(
  options: HostFieldOption[] | undefined,
  mode: MachineTypeSortMode,
): HostFieldOption[] | undefined {
  if (!options?.length) return options;
  const compareAvailable =
    mode === "price"
      ? compareHostOptionsByPrice
      : mode === "cpu"
        ? compareHostOptionsByCpu
        : mode === "value"
          ? compareHostOptionsByValue
          : compareHostOptionsByType;
  const available = options
    .filter((option) => !isUnavailableHostOption(option))
    .sort(compareAvailable);
  const unavailable = options
    .filter((option) => isUnavailableHostOption(option))
    .sort(compareHostOptionsByType);
  return [...available, ...unavailable];
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
        const subLabel = data?.subLabel;
        const detail = data?.priceLabel ?? data?.stateLabel;
        if (!detail && !subLabel) {
          return <span>{mainLabel}</span>;
        }
        return (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 16,
              width: "100%",
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: subLabel ? 2 : 0,
                minWidth: 0,
              }}
            >
              <span>{mainLabel}</span>
              {subLabel ? (
                <span
                  style={{
                    color: COLORS.GRAY_M,
                    fontSize: "12px",
                    lineHeight: 1.3,
                  }}
                >
                  {subLabel}
                </span>
              ) : null}
            </div>
            {detail ? (
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
            ) : null}
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
