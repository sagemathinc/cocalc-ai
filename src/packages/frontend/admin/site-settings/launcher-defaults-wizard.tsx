/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Modal, Select, Space, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import {
  QUICK_CREATE_CATALOG,
  QUICK_CREATE_MAP,
} from "@cocalc/frontend/project/new/launcher-catalog";
import { file_options } from "@cocalc/frontend/editor-tmp";
import type { IconName } from "@cocalc/frontend/components/icon";
import { Icon } from "@cocalc/frontend/components";

interface WizardProps {
  open: boolean;
  onClose: () => void;
  data: Record<string, string>;
  onApply: (values: Record<string, string>) => Promise<void> | void;
}

type Option = { value: string; label: React.ReactNode };

function parseCsv(input: string | undefined): string[] {
  return (input ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function toCsv(values: string[]): string {
  return unique(values).join(",");
}

function extensionOptions(): Option[] {
  const seen = new Set<string>();
  const base = QUICK_CREATE_CATALOG.map((spec) => spec.id);
  const out: Option[] = [];
  for (const id of base) {
    if (seen.has(id)) continue;
    seen.add(id);
    const spec = QUICK_CREATE_MAP[id];
    const data = file_options(`x.${id}`);
    const label = spec?.label ?? data.name ?? id;
    const icon = (spec?.icon ?? data.icon ?? "file") as IconName;
    out.push({
      value: id,
      label: (
        <span>
          <Icon name={icon} /> {label}{" "}
          <span style={{ opacity: 0.65 }}>({id})</span>
        </span>
      ),
    });
  }
  return out;
}
export default function LauncherDefaultsWizard({
  open,
  onClose,
  data,
  onApply,
}: WizardProps) {
  const [quickCreate, setQuickCreate] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setQuickCreate(parseCsv(data.launcher_default_quick_create));
  }, [open, data]);

  const quickOptions = useMemo(extensionOptions, []);

  async function apply() {
    await onApply({
      launcher_default_quick_create: toCsv(quickCreate),
    });
    onClose();
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={apply}
      okText="Apply"
      title="Launcher Defaults Wizard"
      width={720}
    >
      <Space orientation="vertical" style={{ width: "100%" }} size={14}>
        <Alert
          type="info"
          showIcon
          title="Quick Create defaults are an exact list."
          description="Choose the site-wide default Quick Create buttons. Users can override this list in their account settings."
        />
        <div>
          <Typography.Text strong>Site Quick Create buttons</Typography.Text>
          <Select
            mode="tags"
            style={{ width: "100%", marginTop: "6px" }}
            value={quickCreate}
            onChange={(values) => setQuickCreate(unique(values))}
            options={quickOptions}
            tokenSeparators={[",", " "]}
            placeholder="Quick-create ids/extensions (e.g. chat,ipynb,md,tex,term)"
          />
        </div>
      </Space>
    </Modal>
  );
}
