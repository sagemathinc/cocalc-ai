/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Checkbox, Divider, Modal, Select, Space, Typography } from "antd";
import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "@cocalc/frontend/components";
import type { NamedServerName } from "@cocalc/util/types/servers";
import {
  DragHandle,
  SortableItem,
  SortableList,
} from "@cocalc/frontend/components/sortable-list";
import { file_associations } from "@cocalc/frontend/file-associations";
import { file_options } from "@cocalc/frontend/editor-tmp";
import { keys } from "@cocalc/util/misc";
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

function reorder<T>(list: T[], oldIndex: number, newIndex: number): T[] {
  return move(list, oldIndex, newIndex - oldIndex);
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

  function discardChanges() {
    onClose();
  }

  const hiddenQuick = QUICK_CREATE_CATALOG.filter(
    (spec) => !quickCreate.includes(spec.id),
  );
  const hiddenApps = APP_CATALOG.filter((spec) => !apps.includes(spec.id));

  function renderQuickRow(
    id: string,
    checked: boolean,
    draggable: boolean,
    clickable: boolean,
  ) {
    const spec =
      QUICK_CREATE_MAP[id] ??
      (() => {
        const data = file_options(`x.${id}`);
        return {
          icon: data.icon ?? "file",
          label: data.name ?? id,
        };
      })();
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 0",
          cursor: clickable ? "pointer" : undefined,
        }}
        onClick={
          clickable
            ? () => {
                toggleQuickCreate(id, true);
              }
            : undefined
        }
      >
        <Space>
          {draggable ? (
            <DragHandle id={id} />
          ) : (
            <span style={{ width: "18px", display: "inline-block" }} />
          )}
          <Icon name={spec.icon} />
          <span>{spec.label}</span>
        </Space>
        <Checkbox
          checked={checked}
          onChange={(e) => toggleQuickCreate(id, e.target.checked)}
        />
      </div>
    );
  }

  function renderAppRow(
    id: NamedServerName,
    checked: boolean,
    draggable: boolean,
    clickable: boolean,
  ) {
    const spec = APP_MAP[id];
    if (!spec) return null;
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 0",
          cursor: clickable ? "pointer" : undefined,
        }}
        onClick={
          clickable
            ? () => {
                toggleApp(id, true);
              }
            : undefined
        }
      >
        <Space>
          {draggable ? (
            <DragHandle id={id} />
          ) : (
            <span style={{ width: "18px", display: "inline-block" }} />
          )}
          <Icon name={spec.icon} />
          <span>{spec.label}</span>
        </Space>
        <Checkbox
          checked={checked}
          onChange={(e) => toggleApp(id, e.target.checked)}
        />
      </div>
    );
  }

  return (
    <Modal
      title="Customize Launcher"
      open={open}
      onCancel={saveUser}
      onOk={saveUser}
      okText="Save"
      cancelText="Save"
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
            <Button danger onClick={discardChanges}>
              Discard changes
            </Button>
            <Button type="primary" onClick={saveUser}>
              Save
            </Button>
          </Space>
        </Space>
      }
      width={860}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "24px",
        }}
      >
        <div>
          <Typography.Title level={5} style={{ marginBottom: "6px" }}>
            Quick Create
          </Typography.Title>
          <SortableList
            items={quickCreate}
            onDragStop={(oldIndex, newIndex) =>
              setQuickCreate(reorder(quickCreate, oldIndex, newIndex))
            }
            Item={({ id }: { id: string }) =>
              renderQuickRow(id, true, true, false)
            }
          >
            {quickCreate.map((id) => (
              <SortableItem key={id} id={id}>
                {renderQuickRow(id, true, true, false)}
              </SortableItem>
            ))}
          </SortableList>
          {hiddenQuick.length > 0 && (
            <div style={{ marginTop: "8px" }}>
              <Typography.Text type="secondary">
                Available
              </Typography.Text>
              {hiddenQuick.map((spec) => (
                <div key={spec.id}>
                  {renderQuickRow(spec.id, false, false, true)}
                </div>
              ))}
            </div>
          )}
          <Divider style={{ margin: "10px 0" }} />
          <Typography.Text type="secondary">
            Add more file types
          </Typography.Text>
          <Select<string>
            showSearch
            allowClear
            placeholder="Search file types..."
            style={{ width: "100%", marginTop: "6px" }}
            value={undefined}
            options={(() => {
              const list = keys(file_associations).sort();
              const seen = new Set<string>();
              const options: { value: string; label: ReactNode }[] = [];
              for (let ext of list) {
                if (ext === "/" || ext === "sage") continue;
                const data = file_associations[ext];
                if (data?.exclude_from_menu) continue;
                if (data?.name && seen.has(data.name)) continue;
                if (data?.name) seen.add(data.name);
                const value = data?.ext ?? ext;
                if (!value || value === "sage") continue;
                if (quickCreate.includes(value)) continue;
                const info = file_options(`x.${value}`);
                options.push({
                  value,
                  label: (
                    <span>
                      <Icon name={info.icon ?? "file"} />{" "}
                      {info.name ?? value}{" "}
                      <span style={{ opacity: 0.6 }}>({value})</span>
                    </span>
                  ),
                });
              }
              return options;
            })()}
            onSelect={(value: string) => {
              if (!quickCreate.includes(value)) {
                setQuickCreate([value, ...quickCreate]);
              }
            }}
          />
        </div>
        <div>
          <Typography.Title level={5} style={{ marginBottom: "6px" }}>
            Apps
          </Typography.Title>
          <SortableList
            items={apps}
            onDragStop={(oldIndex, newIndex) =>
              setApps(reorder(apps, oldIndex, newIndex) as NamedServerName[])
            }
            Item={({ id }: { id: string }) =>
              renderAppRow(id as NamedServerName, true, true, false)
            }
          >
            {apps.map((id) => (
              <SortableItem key={id} id={id}>
                {renderAppRow(id, true, true, false)}
              </SortableItem>
            ))}
          </SortableList>
          {hiddenApps.length > 0 && (
            <div style={{ marginTop: "8px" }}>
              <Typography.Text type="secondary">
                Available
              </Typography.Text>
              {hiddenApps.map((spec) => (
                <div key={spec.id}>
                  {renderAppRow(spec.id, false, false, true)}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
