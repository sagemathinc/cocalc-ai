/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Modal, Select, Space, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import {
  APP_CATALOG,
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
          <Icon name={icon} /> {label} <span style={{ opacity: 0.65 }}>({id})</span>
        </span>
      ),
    });
  }
  return out;
}

function appOptions(): Option[] {
  return APP_CATALOG.map((spec) => ({
    value: spec.id,
    label: (
      <span>
        <Icon name={spec.icon} /> {spec.label}{" "}
        <span style={{ opacity: 0.65 }}>({spec.id})</span>
      </span>
    ),
  }));
}

export default function LauncherDefaultsWizard({
  open,
  onClose,
  data,
  onApply,
}: WizardProps) {
  const [addQuick, setAddQuick] = useState<string[]>([]);
  const [removeQuick, setRemoveQuick] = useState<string[]>([]);
  const [addApps, setAddApps] = useState<string[]>([]);
  const [removeApps, setRemoveApps] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setAddQuick(parseCsv(data.launcher_default_quick_create));
    setRemoveQuick(parseCsv(data.launcher_remove_quick_create));
    setAddApps(parseCsv(data.launcher_default_apps));
    setRemoveApps(parseCsv(data.launcher_remove_apps));
  }, [open, data]);

  const quickOptions = useMemo(extensionOptions, []);
  const appsOptions = useMemo(appOptions, []);

  async function apply() {
    await onApply({
      launcher_default_quick_create: toCsv(addQuick),
      launcher_remove_quick_create: toCsv(removeQuick),
      launcher_default_apps: toCsv(addApps),
      launcher_remove_apps: toCsv(removeApps),
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
      width={920}
    >
      <Space orientation="vertical" style={{ width: "100%" }} size={14}>
        <Alert
          type="info"
          showIcon
          title="Launcher defaults are additive."
          description="Layers are merged in order: built-in, site, project, account, project-user. Add lists append; remove lists explicitly hide inherited entries."
        />
        <div>
          <Typography.Text strong>Quick Create: add</Typography.Text>
          <Select
            mode="tags"
            style={{ width: "100%", marginTop: "6px" }}
            value={addQuick}
            onChange={(values) => setAddQuick(unique(values))}
            options={quickOptions}
            tokenSeparators={[",", " "]}
            placeholder="Add quick-create ids/extensions (e.g. course,codex)"
          />
        </div>
        <div>
          <Typography.Text strong>Quick Create: remove</Typography.Text>
          <Select
            mode="tags"
            style={{ width: "100%", marginTop: "6px" }}
            value={removeQuick}
            onChange={(values) => setRemoveQuick(unique(values))}
            options={quickOptions}
            tokenSeparators={[",", " "]}
            placeholder="Remove inherited quick-create ids/extensions"
          />
        </div>
        <div>
          <Typography.Text strong>Apps: add</Typography.Text>
          <Select
            mode="tags"
            style={{ width: "100%", marginTop: "6px" }}
            value={addApps}
            onChange={(values) => setAddApps(unique(values))}
            options={appsOptions}
            tokenSeparators={[",", " "]}
            placeholder="Add app ids (e.g. jupyterlab,code)"
          />
        </div>
        <div>
          <Typography.Text strong>Apps: remove</Typography.Text>
          <Select
            mode="tags"
            style={{ width: "100%", marginTop: "6px" }}
            value={removeApps}
            onChange={(values) => setRemoveApps(unique(values))}
            options={appsOptions}
            tokenSeparators={[",", " "]}
            placeholder="Remove inherited app ids"
          />
        </div>
      </Space>
    </Modal>
  );
}
