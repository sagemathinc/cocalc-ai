/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Button,
  Checkbox,
  Divider,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
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
  userBaseQuickCreate?: string[];
  userBaseApps?: NamedServerName[];
  projectBaseQuickCreate?: string[];
  projectBaseApps?: NamedServerName[];
  globalDefaults?: LauncherProjectDefaults;
  onSaveUser?: (prefs: LauncherUserPrefs | null) => void;
  onSaveProject?: (prefs: LauncherProjectDefaults) => void;
  canEditProjectDefaults?: boolean;
  saveMode?: "user" | "project";
  contributions?: LauncherContributionLayer[];
}

export interface LauncherContributionLayer {
  key: string;
  title: string;
  quickCreateAdd?: string[];
  quickCreateRemove?: string[];
  appsAdd?: string[];
  appsRemove?: string[];
}

export function LauncherCustomizeModal({
  open,
  onClose,
  initialQuickCreate,
  initialApps,
  userBaseQuickCreate,
  userBaseApps,
  projectBaseQuickCreate,
  projectBaseApps,
  onSaveUser,
  onSaveProject,
  canEditProjectDefaults = false,
  saveMode = "user",
  contributions = [],
}: Props) {
  const [quickCreate, setQuickCreate] = useState<string[]>([]);
  const [apps, setApps] = useState<NamedServerName[]>([]);
  const [showMergeDetails, setShowMergeDetails] = useState<boolean>(false);
  const userBaseQuick = userBaseQuickCreate ?? initialQuickCreate;
  const userBaseAppList = userBaseApps ?? initialApps;
  const projectBaseQuick = projectBaseQuickCreate ?? userBaseQuick;
  const projectBaseAppList = projectBaseApps ?? userBaseApps ?? initialApps;

  useEffect(() => {
    if (!open) return;
    setQuickCreate(initialQuickCreate);
    setApps(initialApps);
    setShowMergeDetails(false);
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
    if (!onSaveUser) {
      onClose();
      return;
    }
    const addQuick = quickCreate.filter((id) => !userBaseQuick.includes(id));
    const removeQuick = userBaseQuick.filter((id) => !quickCreate.includes(id));
    const addApps = apps.filter((id) => !userBaseAppList.includes(id));
    const removeApps = userBaseAppList.filter((id) => !apps.includes(id));
    onSaveUser({
      quickCreate: addQuick,
      apps: addApps,
      hiddenQuickCreate: removeQuick,
      hiddenApps: removeApps,
    });
    onClose();
  }

  function resetUser() {
    if (!onSaveUser) {
      onClose();
      return;
    }
    onSaveUser(null);
    onClose();
  }

  function saveProjectDefaults() {
    const addQuick = quickCreate.filter((id) => !projectBaseQuick.includes(id));
    const removeQuick = projectBaseQuick.filter((id) => !quickCreate.includes(id));
    const addApps = apps.filter((id) => !projectBaseAppList.includes(id));
    const removeApps = projectBaseAppList.filter((id) => !apps.includes(id));
    onSaveProject?.({
      quickCreate: addQuick,
      apps: addApps as string[],
      hiddenQuickCreate: removeQuick,
      hiddenApps: removeApps,
    });
    onClose();
  }

  function discardChanges() {
    onClose();
  }

  function resetProjectDefaults() {
    onSaveProject?.({});
    onClose();
  }

  const isProjectMode = saveMode === "project";

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

  function quickLabel(id: string): string {
    const spec = QUICK_CREATE_MAP[id];
    if (spec) return spec.label;
    const data = file_options(`x.${id}`);
    return data.name ?? id;
  }

  function appLabel(id: string): string {
    const spec = APP_MAP[id as NamedServerName];
    if (spec) return spec.label;
    return id;
  }

  function renderTags(
    ids: string[] | undefined,
    color: string,
    label: (id: string) => string,
    prefix: string,
  ) {
    if (!ids?.length) {
      return <Typography.Text type="secondary">none</Typography.Text>;
    }
    return (
      <Space size={[6, 6]} wrap>
        {ids.map((id) => (
          <Tag key={`${prefix}-${id}`} color={color} style={{ marginInlineEnd: 0 }}>
            {label(id)} <span style={{ opacity: 0.65 }}>({id})</span>
          </Tag>
        ))}
      </Space>
    );
  }

  return (
    <Modal
      title="Customize Launcher"
      open={open}
      onCancel={isProjectMode ? saveProjectDefaults : saveUser}
      onOk={isProjectMode ? saveProjectDefaults : saveUser}
      okText="Save"
      cancelText="Save"
      footer={
        <Space style={{ width: "100%", justifyContent: "space-between" }}>
          <Space>
            {isProjectMode ? (
              <Button onClick={resetProjectDefaults}>Reset to defaults</Button>
            ) : (
              <Button onClick={resetUser}>Reset to defaults</Button>
            )}
            {!isProjectMode && canEditProjectDefaults && onSaveProject && (
              <Button onClick={saveProjectDefaults} type="default">
                Save as project defaults
              </Button>
            )}
          </Space>
          <Space>
            <Button danger onClick={discardChanges}>
              Discard changes
            </Button>
            <Button
              type="primary"
              onClick={isProjectMode ? saveProjectDefaults : saveUser}
            >
              Save
            </Button>
          </Space>
        </Space>
      }
      width={860}
    >
      <div style={{ marginBottom: "8px" }}>
        <Button
          size="small"
          type="default"
          onClick={() => setShowMergeDetails(!showMergeDetails)}
        >
          <Icon name={showMergeDetails ? "caret-down" : "caret-right"} /> How this
          merges
        </Button>
      </div>
      {showMergeDetails && (
        <div style={{ marginBottom: "14px" }}>
          <Typography.Paragraph style={{ marginBottom: "6px" }}>
            Launcher items are merged additively in this order: built-in defaults, site
            defaults, workspace defaults, account defaults, then workspace-user
            overrides.
          </Typography.Paragraph>
          <Typography.Paragraph style={{ marginBottom: "10px" }}>
            Each layer can add items and explicitly remove inherited items.
          </Typography.Paragraph>
          <Typography.Text strong>Current contributions</Typography.Text>
          <div
            style={{
              marginTop: "6px",
              display: "grid",
              gridTemplateColumns: "1fr",
              gap: "8px",
              maxHeight: "220px",
              overflowY: "auto",
              border: "1px solid #f0f0f0",
              borderRadius: "8px",
              padding: "10px",
            }}
          >
            {contributions.map((layer) => (
              <div
                key={layer.key}
                style={{ borderBottom: "1px dashed #f0f0f0", paddingBottom: "8px" }}
              >
                <Typography.Text strong>{layer.title}</Typography.Text>
                <div style={{ marginTop: "4px" }}>
                  <Typography.Text type="secondary">Quick + </Typography.Text>
                  {renderTags(
                    layer.quickCreateAdd,
                    "blue",
                    quickLabel,
                    `${layer.key}-qadd`,
                  )}
                </div>
                <div style={{ marginTop: "4px" }}>
                  <Typography.Text type="secondary">Quick - </Typography.Text>
                  {renderTags(
                    layer.quickCreateRemove,
                    "volcano",
                    quickLabel,
                    `${layer.key}-qremove`,
                  )}
                </div>
                <div style={{ marginTop: "4px" }}>
                  <Typography.Text type="secondary">Apps + </Typography.Text>
                  {renderTags(
                    layer.appsAdd,
                    "green",
                    appLabel,
                    `${layer.key}-aadd`,
                  )}
                </div>
                <div style={{ marginTop: "4px" }}>
                  <Typography.Text type="secondary">Apps - </Typography.Text>
                  {renderTags(
                    layer.appsRemove,
                    "red",
                    appLabel,
                    `${layer.key}-aremove`,
                  )}
                </div>
              </div>
            ))}
            <div>
              <Typography.Text strong>Effective launcher state</Typography.Text>
              <div style={{ marginTop: "4px" }}>
                <Typography.Text type="secondary">Quick Create: </Typography.Text>
                {renderTags(quickCreate, "processing", quickLabel, "effective-quick")}
              </div>
              <div style={{ marginTop: "4px" }}>
                <Typography.Text type="secondary">Apps: </Typography.Text>
                {renderTags(apps, "success", appLabel, "effective-apps")}
              </div>
            </div>
          </div>
        </div>
      )}
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
