/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { HostCatalog } from "@cocalc/conat/hub/api/hosts";
import { Alert, Flex, Radio, Space, Switch, Tag, Typography } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  getNebiusPlacementOptions,
  type NebiusPlacementOption,
  type ProviderSelection,
} from "../providers/registry";

const { Text } = Typography;

export function NebiusCapacityPicker({
  catalog,
  selection,
  disabled,
  onPricingModelChange,
  onSelect,
}: {
  catalog?: HostCatalog;
  selection: ProviderSelection;
  disabled?: boolean;
  onPricingModelChange: (value: "spot" | "on_demand") => void;
  onSelect: (option: NebiusPlacementOption) => void;
}) {
  const pricingModel =
    selection.pricing_model === "spot" ? "spot" : "on_demand";
  const currentGpuOptions = getNebiusPlacementOptions(
    catalog,
    selection,
    "gpu",
  );
  const currentCpuOptions = getNebiusPlacementOptions(
    catalog,
    selection,
    "cpu",
  );
  const selectedGpu = currentGpuOptions.some(
    ({ region, machineType, platform }) =>
      region === selection.region &&
      machineType === selection.machine_type &&
      platform === selection.provider_platform,
  );
  const selectedCpu = currentCpuOptions.some(
    ({ region, machineType, platform }) =>
      region === selection.region &&
      machineType === selection.machine_type &&
      platform === selection.provider_platform,
  );
  const [kind, setKind] = useState<"cpu" | "gpu">(
    selectedCpu && !selectedGpu ? "cpu" : "gpu",
  );
  const [sortByPrice, setSortByPrice] = useState(false);
  const effectiveKind = pricingModel === "spot" ? "gpu" : kind;
  const options = useMemo(() => {
    const current =
      effectiveKind === "gpu" ? currentGpuOptions : currentCpuOptions;
    if (!sortByPrice) return current;
    return [...current].sort((left, right) => {
      if (left.hourlyRate == null && right.hourlyRate != null) return 1;
      if (left.hourlyRate != null && right.hourlyRate == null) return -1;
      if (
        left.hourlyRate != null &&
        right.hourlyRate != null &&
        left.hourlyRate !== right.hourlyRate
      ) {
        return left.hourlyRate - right.hourlyRate;
      }
      return left.platformLabel.localeCompare(right.platformLabel, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });
  }, [currentCpuOptions, currentGpuOptions, effectiveKind, sortByPrice]);
  const selected = options.find(
    ({ region, machineType, platform }) =>
      region === selection.region &&
      machineType === selection.machine_type &&
      platform === selection.provider_platform,
  );
  const fallbackRequestRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (selected) {
      fallbackRequestRef.current = undefined;
      return;
    }
    if (!options[0]) return;
    const requestKey = [
      pricingModel,
      effectiveKind,
      selection.region ?? "",
      selection.machine_type ?? "",
      selection.provider_platform ?? "",
      options[0].key,
    ].join("\0");
    if (fallbackRequestRef.current === requestKey) return;
    fallbackRequestRef.current = requestKey;
    onSelect(options[0]);
  }, [
    effectiveKind,
    onSelect,
    options,
    pricingModel,
    selected,
    selection.machine_type,
    selection.provider_platform,
    selection.region,
  ]);

  const chooseKind = (nextKind: "cpu" | "gpu") => {
    setKind(nextKind);
    const nextOptions = getNebiusPlacementOptions(catalog, selection, nextKind);
    if (nextOptions[0]) onSelect(nextOptions[0]);
  };

  return (
    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
      <Flex gap={12} wrap align="center">
        <Radio.Group
          aria-label="Nebius pricing model"
          optionType="button"
          buttonStyle="solid"
          disabled={disabled}
          value={pricingModel}
          onChange={(event) => {
            const next = event.target.value as "spot" | "on_demand";
            if (next === "spot") setKind("gpu");
            onPricingModelChange(next);
          }}
        >
          <Radio.Button value="spot">Spot</Radio.Button>
          <Radio.Button value="on_demand">Standard</Radio.Button>
        </Radio.Group>
        <Radio.Group
          aria-label="Nebius compute type"
          optionType="button"
          buttonStyle="solid"
          disabled={disabled}
          value={effectiveKind}
          onChange={(event) => chooseKind(event.target.value)}
        >
          <Radio.Button value="gpu">GPU</Radio.Button>
          <Radio.Button value="cpu" disabled={pricingModel === "spot"}>
            CPU
          </Radio.Button>
        </Radio.Group>
        {pricingModel === "spot" && (
          <Text type="secondary">Nebius Spot capacity is GPU-only.</Text>
        )}
        <Switch
          checked={sortByPrice}
          checkedChildren="Price"
          unCheckedChildren="Recommended"
          disabled={disabled}
          onChange={setSortByPrice}
          aria-label="Sort Nebius machines by price"
        />
      </Flex>

      {options.length === 0 ? (
        <Alert
          showIcon
          type="warning"
          title={`No ${pricingModel === "spot" ? "Spot" : "Standard"} ${effectiveKind.toUpperCase()} capacity is currently reported`}
          description="Try another pricing model or compute type. The list refreshes automatically from Nebius capacity advice."
        />
      ) : (
        <Radio.Group
          aria-label="Available Nebius virtual machines"
          disabled={disabled}
          value={selected?.key}
          onChange={(event) => {
            const option = options.find(
              ({ key }) => key === event.target.value,
            );
            if (option) onSelect(option);
          }}
          style={{ width: "100%" }}
        >
          <div
            style={{
              display: "grid",
              gap: 10,
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              maxHeight: 390,
              overflowY: "auto",
              padding: 2,
            }}
          >
            {options.map((option) => {
              const active = selected?.key === option.key;
              return (
                <Radio
                  key={option.key}
                  value={option.key}
                  style={{
                    alignItems: "flex-start",
                    background: active ? UI_COLORS.infoBg : UI_COLORS.inset,
                    border: `1px solid ${active ? UI_COLORS.link : UI_COLORS.border}`,
                    borderRadius: 8,
                    display: "flex",
                    margin: 0,
                    padding: "10px 12px",
                    width: "100%",
                  }}
                >
                  <Space
                    orientation="vertical"
                    size={3}
                    style={{ width: "100%" }}
                  >
                    <Flex gap={8} justify="space-between" align="start">
                      <Text strong style={{ minWidth: 0 }}>
                        {option.platformLabel}
                      </Text>
                      {option.priceLabel && (
                        <Text
                          strong
                          style={{ flexShrink: 0, whiteSpace: "nowrap" }}
                        >
                          {option.priceLabel}
                        </Text>
                      )}
                    </Flex>
                    <Text code>{option.machineType}</Text>
                    <Text>
                      {option.gpuCount > 0 ? `${option.gpuCount} GPU · ` : ""}
                      {option.cpu} vCPU · {option.ramGiB} GB RAM
                    </Text>
                    <Flex gap={6} wrap align="center">
                      <Tag color="blue">{option.region}</Tag>
                      {option.capacity.reported ? (
                        <Tag color="green">
                          {option.capacity.available} available
                        </Tag>
                      ) : (
                        <Tag>Capacity not reported</Tag>
                      )}
                      {option.capacity.reported &&
                        option.capacity.dataState !== "fresh" && (
                          <Tag>{option.capacity.dataState} data</Tag>
                        )}
                    </Flex>
                  </Space>
                </Radio>
              );
            })}
          </div>
        </Radio.Group>
      )}
    </Space>
  );
}
