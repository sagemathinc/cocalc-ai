import { useId } from "react";
import { Checkbox, InputNumber, Space } from "antd";

export default function VmStopAfter({
  value,
  onChange,
}: {
  value?: number | null;
  onChange?: (minutes: number | null) => void;
}) {
  const id = useId();
  const minutes = value === undefined ? 360 : value;
  return (
    <Space wrap>
      <Checkbox
        checked={minutes !== null}
        onChange={(event) => onChange?.(event.target.checked ? 360 : null)}
      >
        Stop after
      </Checkbox>
      <InputNumber
        id={id}
        aria-label="Stop after hours"
        min={1 / 60}
        max={8760}
        step={1}
        disabled={minutes === null}
        value={minutes === null ? 6 : minutes / 60}
        onChange={(hours) => {
          if (hours != null && hours > 0)
            onChange?.(Math.max(1, Math.round(hours * 60)));
        }}
        style={{ width: 100 }}
      />
      <label htmlFor={id}>hours</label>
    </Space>
  );
}
