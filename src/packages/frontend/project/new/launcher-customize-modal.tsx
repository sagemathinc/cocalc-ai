/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Checkbox, Divider, Modal, Space, Typography } from "antd";
import { useEffect, useState } from "react";
import { Icon } from "@cocalc/frontend/components";
import type { NamedServerName } from "@cocalc/util/types/servers";
import {
  APP_CATALOG,
  APP_MAP,
  QUICK_CREATE_CATALOG,
  QUICK_CREATE_MAP,
} from "./launcher-catalog";
import {
  buildHiddenList,
  LauncherProjectDefaults,
  LauncherUserPrefs,
} from "./launcher-preferences";

function move<T>(list: T[], index: number, delta: number): T[] {
  const next = list.slice();
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

interface Props {
  open: boolean;
  onClose: () => void;
  initialQuickCreate: string[];
  initialApps: NamedServerName[];
  onSaveUser: (prefs: LauncherUserPrefs | null) => void;
  onSaveProject?: (prefs: LauncherProjectDefaults) => void;
  canEditProjectDefaults?: boolean;
}

export function LauncherCustomizeModal({
  open,
  onClose,
  initialQuickCreate,
  initialApps,
  onSaveUser,
  onSaveProject,
  canEditProjectDefaults = false,
}: Props) {
  const [quickCreate, setQuickCreate] = useState<string[]>([]);
  const [apps, setApps] = useState<NamedServerName[]>([]);

  useEffect(() => {
    if (!open) return;
    setQuickCreate(initialQuickCreate);
    setApps(initialApps);
  }, [open, initialQuickCreate, initialApps]);

  function toggleQuickCreate(id: string, checked: boolean) {
    if (checked) {
      if (!quickCreate.includes(id)) {
        setQuickCreate([...quickCreate, id]);
      }
    } else {
      setQuickCreate(quickCreate.filter((item) => item !== id));
    }
  }

  function toggleApp(id: NamedServerName, checked: boolean) {
    if (checked) {
      if (!apps.includes(id)) {
        setApps([...apps, id]);
      }
    } else {
      setApps(apps.filter((item) => item !== id));
    }
  }

  function saveUser() {
    onSaveUser({
      quickCreate,
      apps,
      hiddenQuickCreate: buildHiddenList(quickCreate, QUICK_CREATE_MAP),
      hiddenApps: buildHiddenList(apps, APP_MAP),
    });
    onClose();
  }

  function resetUser() {
    onSaveUser(null);
    onClose();
  }

  function saveProjectDefaults() {
    onSaveProject?.({ quickCreate, apps });
    onClose();
  }

  return (
    <Modal
      title="Customize Launcher"
      open={open}
      onCancel={onClose}
      onOk={saveUser}
      okText="Save for me"
      cancelText="Cancel"
      footer={
        <Space style={{ width: "100%", justifyContent: "space-between" }}>
          <Space>
            <Button onClick={resetUser}>Reset to defaults</Button>
            {canEditProjectDefaults && onSaveProject && (
              <Button onClick={saveProjectDefaults} type="default">
                Save as project defaults
              </Button>
            )}
          </Space>
          <Space>
            <Button onClick={onClose}>Cancel</Button>
            <Button type="primary" onClick={saveUser}>
              Save for me
            </Button>
          </Space>
        </Space>
      }
      width={720}
    >
      <Typography.Title level={4} style={{ marginBottom: "8px" }}>
        Quick Create
      </Typography.Title>
      {QUICK_CREATE_CATALOG.map((spec) => {
        const index = quickCreate.indexOf(spec.id);
        const checked = index !== -1;
        return (
          <div
            key={spec.id}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "6px 0",
            }}
          >
            <Checkbox
              checked={checked}
              onChange={(e) => toggleQuickCreate(spec.id, e.target.checked)}
            >
              <Space>
                <Icon name={spec.icon} />
                <span>{spec.label}</span>
              </Space>
            </Checkbox>
            <Space>
              <Button
                size="small"
                disabled={!checked || index <= 0}
                onClick={() =>
                  setQuickCreate(move(quickCreate, index, -1))
                }
              >
                <Icon name="arrow-up" />
              </Button>
              <Button
                size="small"
                disabled={!checked || index === -1 || index >= quickCreate.length - 1}
                onClick={() =>
                  setQuickCreate(move(quickCreate, index, 1))
                }
              >
                <Icon name="arrow-down" />
              </Button>
            </Space>
          </div>
        );
      })}

      <Divider />

      <Typography.Title level={4} style={{ marginBottom: "8px" }}>
        Apps
      </Typography.Title>
      {APP_CATALOG.map((spec) => {
        const index = apps.indexOf(spec.id);
        const checked = index !== -1;
        return (
          <div
            key={spec.id}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "6px 0",
            }}
          >
            <Checkbox
              checked={checked}
              onChange={(e) => toggleApp(spec.id, e.target.checked)}
            >
              <Space>
                <Icon name={spec.icon} />
                <span>{spec.label}</span>
              </Space>
            </Checkbox>
            <Space>
              <Button
                size="small"
                disabled={!checked || index <= 0}
                onClick={() => setApps(move(apps, index, -1))}
              >
                <Icon name="arrow-up" />
              </Button>
              <Button
                size="small"
                disabled={!checked || index === -1 || index >= apps.length - 1}
                onClick={() => setApps(move(apps, index, 1))}
              >
                <Icon name="arrow-down" />
              </Button>
            </Space>
          </div>
        );
      })}
    </Modal>
  );
}
