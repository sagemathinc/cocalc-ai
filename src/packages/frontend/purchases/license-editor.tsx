/*
React component for editing the PurchaseInfo about one quota purchase.
It doesn't manage actually coordinating purchases, showing prices, or anything
like that.
*/

import {
  Alert,
  DatePicker,
  InputNumber,
  Select,
  Switch,
  Table,
  Tag,
} from "antd";
import dayjs from "dayjs";
import { useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { MAX } from "@cocalc/util/purchases/quota/consts";
import { MIN_DISK_GB } from "@cocalc/util/upgrades/consts";
import type { PurchaseInfo } from "@cocalc/util/purchases/quota/types";
import { FAIR_CPU_MODE } from "@cocalc/util/upgrade-spec";
import { labels } from "@cocalc/frontend/i18n";

interface Changes {
  end?: Date;
  start?: Date;
  quantity?: number;
  custom_ram?: number;
  custom_disk?: number;
  custom_cpu?: number;
  custom_member?: boolean;
  custom_uptime?: "short" | "medium" | "day" | "always_running";
}

type Field =
  | "start"
  | "end"
  | "quantity"
  | "custom_cpu"
  | "custom_ram"
  | "custom_disk"
  | "custom_member"
  | "custom_uptime";

interface Props {
  info: PurchaseInfo;
  onChange: (info: PurchaseInfo) => void;
  style?;
  cellStyle?;
  disabledFields?: Set<Field>;
  hiddenFields?: Set<Field>;
  noCancel?: boolean;
  minDiskGb?: number;
  minRamGb?: number;
}

const END_PRESETS: {
  label: string;
  number: number;
  interval: "day" | "week" | "month" | "year";
  color?: string;
}[] = [
  { label: "1 Day", number: 1, interval: "day", color: "volcano" },
  { label: "1 Week", number: 1, interval: "week", color: "orange" },
  { label: "1 Month", number: 1, interval: "month" },
  { label: "3 Months", number: 3, interval: "month" },
  { label: "4 Months", number: 4, interval: "month" },
  { label: "1 Year", number: 1, interval: "year", color: "green" },
  { label: "Cancel Immediately", number: 0, interval: "day", color: "red" },
];

export default function LicenseEditor({
  info,
  onChange,
  style,
  disabledFields,
  hiddenFields,
  cellStyle,
  noCancel,
  minDiskGb = MIN_DISK_GB,
  minRamGb = 4,
}: Props) {
  const intl = useIntl();
  const projectsLabel = intl.formatMessage(labels.projects);
  const isVouchers = info.type == "vouchers";
  const quotaInfo = info.type == "quota" ? info : null;

  const [start, setStart] = useState<dayjs.Dayjs | undefined>(
    quotaInfo?.start ? dayjs(quotaInfo.start) : undefined,
  );
  const [end, setEnd] = useState<dayjs.Dayjs | undefined>(
    quotaInfo?.end ? dayjs(quotaInfo.end) : undefined,
  );
  const columns = [
    {
      title: <div style={{ textAlign: "center" }}>Field</div>,
      dataIndex: "field",
      key: "field",
      render: (field) => <div style={cellStyle}>{field}</div>,
    },
    {
      title: <div style={{ textAlign: "center" }}>Value</div>,
      dataIndex: "value",
      key: "value",
      render: (field) => <div style={cellStyle}>{field}</div>,
    },
  ];

  const handleFieldChange = (field: keyof Changes) => (value: any) => {
    if (field == "start" || field == "end") {
      if (field == "start") {
        setStart(value);
      } else if (field == "end") {
        setEnd(value);
      }
      value = value?.toDate();
    }
    onChange({ ...info, [field]: value });
  };

  const isSubscription =
    quotaInfo?.subscription != null && quotaInfo.subscription != "no";

  const endPresets = useMemo(() => {
    if (isSubscription || start == null) {
      return null;
    }

    return (
      <div style={{ marginTop: "8px" }}>
        {END_PRESETS.map(({ label, interval, number, color }) => {
          if (noCancel && number == 0) return null;
          return (
            <Tag
              key={label}
              style={{ cursor: "pointer", marginTop: "5px" }}
              color={color ?? "blue"}
              onClick={() => {
                const now = dayjs();
                const end = (
                  start === undefined || now.diff(start) > 0 ? now : start
                ).add(number, interval);
                handleFieldChange("end")(end);
              }}
            >
              {label}
            </Tag>
          );
        })}
      </div>
    );
  }, [isSubscription, start?.valueOf() ?? 0]);

  if (isVouchers) {
    return <Alert type="error" title="Editing vouchers is not allowed." />;
  }

  let data = [
    {
      key: "start",
      field: "Start",
      value: (
        <DatePicker
          showTime
          changeOnBlur
          allowClear={false}
          disabled={isSubscription || disabledFields?.has("start")}
          value={start}
          onChange={handleFieldChange("start")}
          disabledDate={(current) => current < dayjs().startOf("day")}
        />
      ),
    },
    {
      key: "end",
      field: "End",
      value: (
        <div>
          <DatePicker
            showTime
            changeOnBlur
            allowClear={false}
            disabled={isSubscription || disabledFields?.has("end")}
            value={end}
            onChange={handleFieldChange("end")}
            disabledDate={(current) => {
              if (current <= dayjs().startOf("day")) {
                return true;
              }
              if (start != null && current <= dayjs(start)) {
                return true;
              }
              return false;
            }}
          />
          {isSubscription && (
            <div style={{ color: "#666", marginTop: "15px" }}>
              Subscription Start and End dates cannot be edited.
            </div>
          )}
          {endPresets}
        </div>
      ),
    },

    ...(info.type == "quota"
      ? [
          {
            key: "quantity",
            field: "Run Limit",
            value: (
              <InputNumber
                disabled={disabledFields?.has("quantity")}
                min={1}
                step={1}
                value={info.quantity}
                onChange={handleFieldChange("quantity")}
                suffix={projectsLabel}
              />
            ),
          },
          {
            key: "custom_ram",
            field: "RAM",
            value: (
              <InputNumber
                disabled={disabledFields?.has("custom_ram")}
                min={minRamGb}
                max={MAX.ram}
                step={1}
                value={info.custom_ram}
                onChange={handleFieldChange("custom_ram")}
                suffix={"GB"}
              />
            ),
          },
          {
            key: "custom_disk",
            field: "Disk",
            value: (
              <InputNumber
                disabled={disabledFields?.has("custom_disk")}
                min={Math.min(info.custom_disk || minDiskGb, minDiskGb)}
                max={MAX.disk}
                step={1}
                value={info.custom_disk}
                onChange={handleFieldChange("custom_disk")}
                suffix={"GB"}
              />
            ),
          },
          FAIR_CPU_MODE
            ? { key: "nothing", value: null }
            : {
                key: "custom_cpu",
                field: "CPU",
                value: (
                  <InputNumber
                    disabled={disabledFields?.has("custom_cpu")}
                    min={1}
                    max={MAX.cpu}
                    step={1}
                    value={info.custom_cpu}
                    onChange={handleFieldChange("custom_cpu")}
                    suffix={"Shared vCPU"}
                  />
                ),
              },
          {
            key: "custom_member",
            field: "Member Hosting",
            value: (
              <Switch
                disabled={disabledFields?.has("custom_member")}
                checked={info.custom_member}
                onChange={handleFieldChange("custom_member")}
              />
            ),
          },
          {
            key: "custom_uptime",
            field: "Idle Timeout",
            value: (
              <Select
                disabled={disabledFields?.has("custom_uptime")}
                style={{ width: "100%" }}
                value={info.custom_uptime}
                onChange={handleFieldChange("custom_uptime")}
              >
                <Select.Option value="short">Short (30 minutes)</Select.Option>
                <Select.Option value="medium">Medium (2 hours)</Select.Option>
                <Select.Option value="day">Day (24 hours)</Select.Option>
                <Select.Option value="always_running">
                  Always Running
                </Select.Option>
              </Select>
            ),
          },
        ]
      : []),
  ];

  if (hiddenFields) {
    data = data.filter((x) => !hiddenFields.has(x.key as Field));
  }

  return (
    <Table
      bordered
      style={style}
      columns={columns}
      dataSource={data}
      pagination={false}
    />
  );
}
