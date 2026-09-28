/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { Radio } from "antd";

export function AgentSpeedControl({
  id,
  value,
  onChange,
  disabled,
  fastModeSupported = true,
}: {
  id?: string;
  value?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  fastModeSupported?: boolean;
}) {
  return (
    <Radio.Group
      id={id}
      aria-label="Speed"
      optionType="button"
      buttonStyle="solid"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange?.(event.target.value)}
    >
      <Radio.Button value="standard">Standard</Radio.Button>
      <Radio.Button value="fast" disabled={!fastModeSupported}>
        Fast
      </Radio.Button>
    </Radio.Group>
  );
}
